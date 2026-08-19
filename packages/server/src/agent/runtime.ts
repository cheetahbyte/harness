import {
	Agent,
	type AgentMessage,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type CredentialStore,
	clampThinkingLevel,
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	type Model,
	type Models,
} from "@earendil-works/pi-ai";

import { abortableSleep } from "../../../shared/src/abortable-sleep";
import type {
	ImageAttachment,
	ModelConfig,
	ServerEvent,
} from "../../../shared/src/protocol";
import { compactWithLlm } from "../context/llm-compactor";
import {
	ContextBudgetError,
	type ContextCompactor,
	type ContextManager,
} from "../context/manager";
import { log } from "../logger";
import type { McpRegistry, McpToolDescriptor } from "../mcp/registry";
import { HarnezProviderError, providerModels } from "../provider";
import type { SessionStore } from "../sessions/store";
import type { SkillSnapshotEntry } from "../skills";
import type { TaskRuntime } from "../task-runtime";
import type { RuntimeEventSink } from "../telemetry/events";
import { tokenCost } from "../token-cost";
import type { CoreTools } from "../tools";
import {
	type AgentEntry,
	ensureSystem,
	managedMessages,
	managedMessagesAsync,
	type QueueCallbacks,
	queueMessage,
	translateAgentEvent,
} from "./events";
export { SYSTEM_PROMPT } from "../system-prompt";
import { messageKey } from "./message";
import { agentTools, TOOL_OVERHEAD_TOKENS } from "./tools";

export type AgentRunInput = {
	sessionId: string;
	text: string;
	images?: ImageAttachment[];
	config: ModelConfig | undefined;
	tools: CoreTools;
	task: TaskRuntime;
	skills: readonly SkillSnapshotEntry[];
	mcpTools: readonly McpToolDescriptor[];
	/** The workspace's registry: MCP is per workspace, not per process. */
	mcp: Pick<McpRegistry, "call">;
	signal: AbortSignal;
	emit: (event: ServerEvent) => void;
	turnId?: number;
};

export type AgentRunTiming = {
	modelDurationMs: number;
	toolDurationMs: number;
};

const DEFAULT_CONTEXT_BUDGET = 80_000;
/** Floor for models that cannot be resolved, and the old fixed ceiling. */
const FALLBACK_CAPABILITY_BUDGET = 8_000;

/** Pi is contained here: server code only sees Harnez events and model configuration. */
export class HarnezAgentRuntime {
	private readonly agents = new Map<string, AgentEntry>();
	private readonly credentials: CredentialStore;
	private readonly modelsFor: (sessionId: string) => Models;
	private readonly store: SessionStore;
	private readonly context: ContextManager;
	private readonly contextBudget: number;
	private readonly llmCompaction: boolean;

	constructor(options: {
		credentials: CredentialStore;
		modelsFor: (sessionId: string) => Models;
		store: SessionStore;
		context: ContextManager;
		contextBudget?: number;
		llmCompaction?: boolean;
		sink?: RuntimeEventSink;
	}) {
		this.credentials = options.credentials;
		this.modelsFor = options.modelsFor;
		this.store = options.store;
		this.context = options.context;
		this.contextBudget = options.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
		this.llmCompaction =
			options.llmCompaction ?? process.env["HARNEZ_LLM_COMPACTION"] !== "0";
		this.sink = options.sink;
	}
	private readonly sink: RuntimeEventSink | undefined;
	private requestId = 0;

	supportsImages(sessionId: string, config: ModelConfig | undefined): boolean {
		if (!config) return false;
		try {
			return providerModels(
				config,
				this.credentials,
				this.modelsFor(sessionId),
			).model.input.includes("image");
		} catch {
			return false;
		}
	}

	async run({
		sessionId,
		text,
		images = [],
		config,
		tools,
		task,
		skills,
		mcpTools,
		mcp,
		signal,
		emit,
		turnId,
	}: AgentRunInput): Promise<AgentRunTiming> {
		if (!config)
			throw new HarnezProviderError(
				"no model configured; use /model",
				"configuration",
			);
		const key = `${JSON.stringify(config)}:${task.id}`;
		let entry = this.agents.get(sessionId);
		if (!entry || entry.key !== key) {
			const { models, model } = providerModels(
				config,
				this.credentials,
				this.modelsFor(sessionId),
			);
			const created = this.createAgent({
				sessionId,
				key,
				model,
				models,
				tools,
				config,
				task,
				skills,
				mcpTools,
				mcp,
			});
			created.agent.subscribe((event) => {
				translateAgentEvent({
					sessionId,
					entry: created,
					event,
					emit,
					context: this.context,
					shrink: () => this.shrink(sessionId, created),
					inspect: () => this.inspect(sessionId),
					...(this.sink ? { sink: this.sink } : {}),
				});
			});
			this.agents.set(sessionId, created);
			entry = created;
		}
		entry.emit = emit;
		entry.turnId = turnId ?? entry.turnId + 1;
		const message: AgentMessage = {
			role: "user",
			content: [
				{ type: "text", text },
				...images.map((image) => ({
					type: "image" as const,
					data: image.data,
					mimeType: image.mimeType,
				})),
			],
			timestamp: Date.now(),
		};
		entry.promptGroupId = crypto.randomUUID();
		try {
			/**
			 * The first assembly of a turn is usually the one that crosses the
			 * budget, so it has to carry the emitter too — otherwise the cleanup it
			 * performs is silent and every later assembly finds nothing to report.
			 */
			await this.messagesAsync(
				sessionId,
				entry.agent.state.model,
				entry.task,
				signal,
				entry.compactor,
				emit,
				turnId,
				[
					{
						sessionId,
						kind: "user",
						payload: message,
						tokenCost: tokenCost(message, 1),
						lifecycle: "pinned",
						reason: "user-authored message",
						groupId: entry.promptGroupId,
					},
				],
				entry.agent.state.tools,
			);
		} catch (error) {
			this.context.completeGroup(sessionId, entry.promptGroupId);
			entry.promptGroupId = undefined;
			throw error;
		}
		entry.preRecorded.add(messageKey(message));
		this.context.markAgentProgress(task.id);
		const abort = () => entry?.agent.abort();
		signal.addEventListener("abort", abort, { once: true });
		try {
			await entry.agent.prompt(message);
		} catch (error) {
			log.error({ err: error, sessionId }, "agent prompt failed");
			if (!signal.aborted) throw normalizeProviderError(error);
		} finally {
			signal.removeEventListener("abort", abort);
		}
		return {
			modelDurationMs: Math.round(entry.timing.modelDurationMs),
			toolDurationMs: Math.round(entry.timing.toolDurationMs),
		};
	}

	/**
	 * Tool contracts and skill bodies have to follow the model the same way the
	 * transcript does. A fixed ceiling made the outcome depend on which constant
	 * was compiled in rather than on what the model could hold: under the 8k
	 * literal this replaces, a mid-sized skill could not be activated at all on a
	 * 200k model. An unconfigured or unresolvable model falls back to that
	 * constant, since the run is about to fail on the missing model anyway.
	 */
	capabilityBudget(sessionId: string, config: ModelConfig | undefined): number {
		if (!config) return FALLBACK_CAPABILITY_BUDGET;
		try {
			const { model } = providerModels(
				config,
				this.credentials,
				this.modelsFor(sessionId),
			);
			return this.contextOptions(model).budget;
		} catch (error) {
			log.warn(
				{ err: error, sessionId, model: config.model },
				"capability budget falling back to the default ceiling",
			);
			return FALLBACK_CAPABILITY_BUDGET;
		}
	}

	steer(
		sessionId: string,
		text: string,
		callbacks: QueueCallbacks,
		images: readonly ImageAttachment[] = [],
	): boolean {
		const entry = this.agents.get(sessionId);
		if (
			!entry?.agent.state.isStreaming ||
			entry.agent.state.pendingToolCalls.size
		)
			return false;
		if (entry.steering) entry.steering.onReplaced?.();
		entry.agent.clearSteeringQueue();
		const queued = queueMessage(text, callbacks, images);
		entry.steering = queued;
		entry.queued.set(queued.message, queued);
		entry.agent.steer(queued.message as never);
		return true;
	}
	forget(sessionId: string): void {
		this.agents.delete(sessionId);
	}
	inspect(sessionId: string): ReturnType<ContextManager["inspect"]> {
		const model = this.agents.get(sessionId)?.agent.state.model;
		return this.context.inspect(
			sessionId,
			model
				? this.contextOptions(model)
				: {
						budget: this.contextBudget,
						target: Math.floor(this.contextBudget * 0.8),
						overheadTokens: TOOL_OVERHEAD_TOKENS,
					},
		);
	}

	private createAgent({
		sessionId,
		key,
		model,
		models,
		tools,
		config,
		task,
		skills,
		mcpTools,
		mcp,
	}: {
		sessionId: string;
		key: string;
		model: Model<Api>;
		models: ReturnType<typeof providerModels>["models"];
		tools: CoreTools;
		config: ModelConfig;
		task: TaskRuntime;
		skills: readonly SkillSnapshotEntry[];
		mcpTools: readonly McpToolDescriptor[];
		mcp: Pick<McpRegistry, "call">;
	}): AgentEntry {
		const systemPrompt = ensureSystem({
			sessionId,
			store: this.store,
			context: this.context,
			workspace: this.store.workspace(sessionId) ?? process.cwd(),
		});
		const entry = newAgentEntry(key, tools, task, this.sink);
		const compactor: ContextCompactor | undefined = !this.llmCompaction
			? undefined
			: (request) => compactWithLlm({ ...request, model, models });
		/**
		 * Publishes a tool mid-task. `entry.agent` is assigned before any tool can
		 * run, so the deferred read is always resolved by the time this fires.
		 * Re-admitting the same name is ignored: `tools_load` is idempotent.
		 */
		const admit = (tool: AgentTool): void => {
			const current = entry.agent.state.tools;
			if (current.some((existing) => existing.name === tool.name)) return;
			entry.agent.state.tools = [...current, tool];
		};
		const managed = async (signal?: AbortSignal): Promise<AgentMessage[]> => {
			try {
				entry.contextError = undefined;
				return await this.messagesAsync(
					sessionId,
					model,
					task,
					signal ?? new AbortController().signal,
					compactor,
					entry.emit,
					entry.turnId,
					undefined,
					entry.agent.state.tools,
				);
			} catch (error) {
				entry.contextError = asError(error);
				return [];
			}
		};
		const agent = new Agent({
			sessionId,
			initialState: {
				model,
				thinkingLevel: clampThinkingLevel(
					model,
					config.thinkingLevel ?? "medium",
				),
				systemPrompt,
				tools: agentTools({
					sessionId,
					model,
					tools,
					task,
					skills,
					mcpTools,
					mcp,
					admit,
					context: this.context,
					contextOptions: this.contextOptions.bind(this),
					previewLimit: this.previewLimit.bind(this),
					...(entry.emit ? { emit: entry.emit } : {}),
				}),
				messages: [],
			},
			transformContext: async (_messages, signal) => {
				const messages = await managed(signal);
				task.context.completeStep();
				return messages;
			},
			prepareNextTurnWithContext: async (turn, signal) => {
				this.context.completeTurn(
					sessionId,
					turn.toolResults.map((result) => result.toolCallId),
				);
				const messages = await managed(signal);
				agent.state.messages = messages;
				/**
				 * Pi snapshots the tool list once when a prompt starts and then reuses
				 * whatever context this hook returns, so the tools have to be re-read
				 * here. Without it, a tool that `tools_load` published earlier in the
				 * run stays invisible for the rest of it: the model is told the load
				 * succeeded and every later call comes back "not found".
				 */
				return {
					context: { ...turn.context, messages, tools: agent.state.tools },
				};
			},
			shouldStopAfterTurn: () => !!entry.contextError,
			streamFn: (_unused, requestContext, options) => {
				if (entry.contextError) throw entry.contextError;
				const requestIds = new Map<number, number>();
				let retryContext = requestContext;
				return streamWithRetry(
					() => models.streamSimple(model, retryContext, options),
					options?.signal,
					{ sessionId, provider: config.provider, model: config.model },
					(durationMs) => (entry.timing.modelDurationMs += durationMs),
					(phase, attempt, durationMs, error, response) => {
						const requestId = requestIds.get(attempt) ?? this.requestId++;
						if (phase === "started") requestIds.set(attempt, requestId);
						else requestIds.delete(attempt);
						this.sink?.({
							type:
								phase === "started"
									? "model.request.started"
									: phase === "failed"
										? "model.request.failed"
										: "model.request.completed",
							timestamp: new Date().toISOString(),
							sessionId,
							taskId: task.id,
							turnId: entry.turnId,
							requestId,
							attempt,
							provider: config.provider,
							model: config.model,
							...(durationMs === undefined ? {} : { durationMs }),
							...(error ? { error } : {}),
							...(phase === "started"
								? { prompt: retryContext }
								: response
									? { response }
									: {}),
						});
					},
					() => {
						this.context.checkpointProviderOverflow(sessionId);
						retryContext = {
							...requestContext,
							messages: this.messages(
								sessionId,
								model,
								task,
								entry.emit,
							) as typeof requestContext.messages,
						};
					},
				);
			},
			toolExecution: "parallel",
		});
		entry.agent = agent;
		entry.compactor = compactor;
		return entry;
	}
	private async messagesAsync(
		sessionId: string,
		model: Model<Api>,
		task: TaskRuntime,
		signal: AbortSignal,
		compactor?: ContextCompactor,
		emit?: ((event: ServerEvent) => void) | undefined,
		turnId?: number,
		pendingInput?: Parameters<typeof managedMessagesAsync>[0]["pendingInput"],
		tools: unknown[] = [],
	): Promise<AgentMessage[]> {
		if (pendingInput?.length) {
			await managedMessagesAsync({
				sessionId,
				model,
				task,
				context: this.context,
				contextOptions: this.contextOptions.bind(this),
				signal,
				pendingInput,
				tools,
				...(compactor ? { compactor } : {}),
			});
			return this.messages(sessionId, model, task, emit, turnId);
		}
		const options = this.contextOptions(model);
		try {
			const messages = this.messages(sessionId, model, task, emit, turnId);
			const inspection = this.context.inspect(sessionId, options);
			if (inspection.estimatedTokens < Math.floor(options.budget * 0.8))
				return messages;
		} catch (error) {
			if (!(error instanceof ContextBudgetError)) throw error;
		}
		await managedMessagesAsync({
			sessionId,
			model,
			task,
			context: this.context,
			contextOptions: this.contextOptions.bind(this),
			signal,
			...(compactor ? { compactor } : {}),
			tools,
		});
		return this.messages(sessionId, model, task, emit, turnId);
	}
	private messages(
		sessionId: string,
		model: Model<Api>,
		task?: TaskRuntime,
		emit?: ((event: ServerEvent) => void) | undefined,
		turnId?: number,
	): AgentMessage[] {
		return managedMessages({
			sessionId,
			model,
			...(task ? { task } : {}),
			store: this.store,
			context: this.context,
			contextOptions: this.contextOptions.bind(this),
			...(emit ? { emit } : {}),
			...(turnId === undefined ? {} : { turnId }),
		});
	}
	private contextOptions(model: Model<Api>): {
		budget: number;
		target: number;
		overheadTokens: number;
	} {
		const outputReserve = Math.min(
			model.maxTokens,
			Math.floor(model.contextWindow / 2),
		);
		const hardInput = model.contextWindow - outputReserve;
		if (!Number.isFinite(hardInput) || hardInput <= 0)
			throw new HarnezProviderError(
				`model ${model.id} has no usable input context window`,
				"configuration",
			);
		const budget = Math.min(this.contextBudget, hardInput);
		return {
			budget,
			target: Math.floor(budget * 0.8),
			overheadTokens: TOOL_OVERHEAD_TOKENS,
		};
	}
	private previewLimit(model: Model<Api>): number {
		return Math.min(
			16_000,
			Math.max(128, Math.floor(this.contextOptions(model).budget / 2)),
		);
	}
	private shrink(sessionId: string, entry: AgentEntry): void {
		try {
			entry.agent.state.messages = this.messages(
				sessionId,
				entry.agent.state.model,
				entry.task,
				entry.emit,
			);
		} catch (error) {
			entry.contextError = asError(error);
		}
	}
}

function normalizeProviderError(error: unknown): HarnezProviderError {
	return error instanceof HarnezProviderError
		? error
		: new HarnezProviderError(
				error instanceof Error ? error.message : String(error),
			);
}
const MAX_STREAM_RETRIES = 3;
const STREAM_RETRY_BASE_DELAY_MS = 500;
function streamWithRetry(
	produce: () => AssistantMessageEventStream,
	signal: AbortSignal | undefined,
	context: { sessionId: string; provider: string; model: string },
	onComplete: (durationMs: number) => void,
	onAttempt?: (
		phase: "started" | "completed" | "failed",
		attempt: number,
		durationMs: number | undefined,
		error?: string,
		response?: unknown,
	) => void,
	onContextLength?: () => void,
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		let retriedContextLength = false;
		for (let attempt = 0; ; attempt++) {
			log.debug(
				{ ...context, attempt: attempt + 1 },
				"provider stream started",
			);
			let terminal:
				| Extract<AssistantMessageEvent, { type: "done" | "error" }>
				| undefined;
			const startedAt = performance.now();
			onAttempt?.("started", attempt + 1, undefined);
			try {
				for await (const event of produce())
					if (event.type === "done" || event.type === "error") terminal = event;
					else out.push(event);
			} finally {
				const durationMs = performance.now() - startedAt;
				onComplete(durationMs);
				onAttempt?.(
					terminal?.type === "error" ? "failed" : "completed",
					attempt + 1,
					Math.round(durationMs),
					terminal?.type === "error" ? terminal.error.errorMessage : undefined,
					terminal?.type === "done" ? terminal.message : terminal?.error,
				);
			}
			if (!terminal) {
				log.warn(
					{ ...context, attempt: attempt + 1 },
					"provider stream ended without terminal event",
				);
				return;
			}
			const retryError = terminal.type === "error" ? terminal.error : undefined;
			const contextLength =
				terminal.type === "error" &&
				terminal.reason === "error" &&
				isContextLengthError(terminal.error.errorMessage);
			if (contextLength && !retriedContextLength) {
				retriedContextLength = true;
				try {
					onContextLength?.();
					continue;
				} catch (error) {
					log.warn(
						{ ...context, err: error },
						"context-length recovery could not prepare a retry",
					);
					return out.push(terminal);
				}
			}
			const retryable =
				terminal.type === "error" &&
				terminal.reason === "error" &&
				!contextLength &&
				attempt < MAX_STREAM_RETRIES &&
				isRetryableAssistantError(terminal.error);
			if (!retryable) {
				if (terminal.type === "error" && terminal.reason === "aborted")
					log.info(
						{ ...context, attempt: attempt + 1 },
						"provider stream aborted",
					);
				else if (terminal.type === "error")
					log.error(
						{
							...context,
							attempt: attempt + 1,
							error: retryError?.errorMessage,
						},
						"provider stream failed",
					);
				else
					log.debug(
						{ ...context, attempt: attempt + 1 },
						"provider stream completed",
					);
				return out.push(terminal);
			}
			const delayMs = STREAM_RETRY_BASE_DELAY_MS * 2 ** attempt;
			log.warn(
				{
					...context,
					attempt: attempt + 1,
					delayMs,
					error: retryError?.errorMessage,
				},
				"provider stream failed; retrying",
			);
			await abortableSleep(delayMs, signal);
			if (signal?.aborted) return out.push(terminal);
		}
	})();
	return out;
}
function isContextLengthError(message: string | undefined): boolean {
	return /context(?: window| length)|maximum context|too many tokens/i.test(
		message ?? "",
	);
}
function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function newAgentEntry(
	key: string,
	tools: CoreTools,
	task: TaskRuntime,
	sink?: RuntimeEventSink,
): AgentEntry {
	return {
		key,
		agent: undefined as unknown as Agent,
		tools,
		contextError: undefined,
		compactor: undefined,
		promptGroupId: undefined,
		preRecorded: new Set(),
		toolGroups: new Map(),
		queued: new WeakMap(),
		active: [],
		steering: undefined,
		task,
		timing: {
			modelDurationMs: 0,
			toolDurationMs: 0,
			activeToolCalls: new Set(),
			toolWindowStartedAt: undefined,
		},
		emit: undefined,
		sink,
		turnId: 0,
		callIds: new Map(),
		callStarted: new Map(),
	};
}
