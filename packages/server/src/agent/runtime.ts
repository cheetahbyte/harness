import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
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
import type { ModelConfig, ServerEvent } from "../../../shared/src/protocol";
import type { ContextManager } from "../context/manager";
import { log } from "../logger";
import { HarnezProviderError, providerModels } from "../provider";
import type { SessionStore } from "../sessions/store";
import type { SkillSnapshotEntry } from "../skills";
import type { TaskRuntime } from "../task-runtime";
import type { CoreTools } from "../tools";
import {
	type AgentEntry,
	ensureSystem,
	managedMessages,
	type QueueCallbacks,
	queueMessage,
	recordAgentMessage,
	translateAgentEvent,
} from "./events";
import { messageKey } from "./message";
import { agentTools, TOOL_OVERHEAD_TOKENS } from "./tools";

export type AgentRunInput = {
	sessionId: string;
	text: string;
	config: ModelConfig | undefined;
	tools: CoreTools;
	task: TaskRuntime;
	skills: readonly SkillSnapshotEntry[];
	signal: AbortSignal;
	emit: (event: ServerEvent) => void;
};

export type AgentRunTiming = {
	modelDurationMs: number;
	toolDurationMs: number;
};

export const SYSTEM_PROMPT =
	"You are Harnez, a coding agent. Use deterministic capability discovery when you need more context, and use the provided tools to inspect and change the current workspace. Batch independent tool calls, including related reads, writes, and edits, in the same turn. Tool output carrying an observation:// reference was archived, not lost: read it back with recall_observation instead of running the tool again. Use episodes and pin_context once context is reported to be under compaction pressure, or when the work ahead will span many tool calls; skip episodes and pin_context for short tasks. Runtime context belongs only to the current task.";
const DEFAULT_CONTEXT_BUDGET = 80_000;

/** Pi is contained here: server code only sees Harnez events and model configuration. */
export class HarnezAgentRuntime {
	private readonly agents = new Map<string, AgentEntry>();
	private readonly credentials: CredentialStore;
	private readonly modelsFor: (sessionId: string) => Models;
	private readonly store: SessionStore;
	private readonly context: ContextManager;
	private readonly contextBudget: number;

	constructor(options: {
		credentials: CredentialStore;
		modelsFor: (sessionId: string) => Models;
		store: SessionStore;
		context: ContextManager;
		contextBudget?: number;
	}) {
		this.credentials = options.credentials;
		this.modelsFor = options.modelsFor;
		this.store = options.store;
		this.context = options.context;
		this.contextBudget = options.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
	}

	async run({
		sessionId,
		text,
		config,
		tools,
		task,
		skills,
		signal,
		emit,
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
			});
			created.agent.subscribe((event) =>
				translateAgentEvent({
					sessionId,
					entry: created,
					event,
					emit,
					context: this.context,
					shrink: () => this.shrink(sessionId, created),
					inspect: () => this.inspect(sessionId),
				}),
			);
			this.agents.set(sessionId, created);
			entry = created;
		}
		entry.emit = emit;
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
		entry.promptGroupId = crypto.randomUUID();
		recordAgentMessage({ sessionId, entry, message, context: this.context });
		try {
			/**
			 * The first assembly of a turn is usually the one that crosses the
			 * budget, so it has to carry the emitter too — otherwise the cleanup it
			 * performs is silent and every later assembly finds nothing to report.
			 */
			this.messages(sessionId, entry.agent.state.model, entry.task, emit);
		} catch (error) {
			this.context.completeGroup(sessionId, entry.promptGroupId);
			entry.promptGroupId = undefined;
			throw error;
		}
		entry.preRecorded.add(messageKey(message));
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

	steer(sessionId: string, text: string, callbacks: QueueCallbacks): boolean {
		const entry = this.agents.get(sessionId);
		if (
			!entry?.agent.state.isStreaming ||
			entry.agent.state.pendingToolCalls.size
		)
			return false;
		if (entry.steering) entry.steering.onReplaced?.();
		entry.agent.clearSteeringQueue();
		const queued = queueMessage(text, callbacks);
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
	}: {
		sessionId: string;
		key: string;
		model: Model<Api>;
		models: ReturnType<typeof providerModels>["models"];
		tools: CoreTools;
		config: ModelConfig;
		task: TaskRuntime;
		skills: readonly SkillSnapshotEntry[];
	}): AgentEntry {
		ensureSystem({
			sessionId,
			store: this.store,
			context: this.context,
			systemPrompt: SYSTEM_PROMPT,
		});
		const entry = newAgentEntry(key, tools, task);
		const managed = (): AgentMessage[] => {
			try {
				entry.contextError = undefined;
				return this.messages(sessionId, model, task, entry.emit);
			} catch (error) {
				entry.contextError = asError(error);
				return [];
			}
		};
		const agent = new Agent({
			initialState: {
				model,
				thinkingLevel: clampThinkingLevel(
					model,
					config.thinkingLevel ?? "medium",
				),
				systemPrompt: SYSTEM_PROMPT,
				tools: agentTools({
					sessionId,
					model,
					tools,
					task,
					skills,
					context: this.context,
					contextOptions: this.contextOptions.bind(this),
					previewLimit: this.previewLimit.bind(this),
				}),
				messages: this.messages(sessionId, model, task),
			},
			transformContext: async () => managed(),
			prepareNextTurnWithContext: (turn) => {
				this.context.completeTurn(
					sessionId,
					turn.toolResults.map((result) => result.toolCallId),
				);
				const messages = managed();
				agent.state.messages = messages;
				return { context: { ...turn.context, messages } };
			},
			shouldStopAfterTurn: () => !!entry.contextError,
			streamFn: (_unused, requestContext, options) => {
				if (entry.contextError) throw entry.contextError;
				return streamWithRetry(
					() => models.streamSimple(model, requestContext, options),
					options?.signal,
					{ sessionId, provider: config.provider, model: config.model },
					(durationMs) => (entry.timing.modelDurationMs += durationMs),
				);
			},
			toolExecution: "parallel",
		});
		entry.agent = agent;
		return entry;
	}
	private messages(
		sessionId: string,
		model: Model<Api>,
		task?: TaskRuntime,
		emit?: ((event: ServerEvent) => void) | undefined,
	): AgentMessage[] {
		return managedMessages({
			sessionId,
			model,
			...(task ? { task } : {}),
			store: this.store,
			context: this.context,
			contextOptions: this.contextOptions.bind(this),
			...(emit ? { emit } : {}),
		});
	}
	private contextOptions(model: Model<Api>): {
		budget: number;
		target: number;
		overheadTokens: number;
	} {
		const hardInput = model.contextWindow - model.maxTokens;
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
): AssistantMessageEventStream {
	const out = createAssistantMessageEventStream();
	void (async () => {
		for (let attempt = 0; ; attempt++) {
			log.debug(
				{ ...context, attempt: attempt + 1 },
				"provider stream started",
			);
			let terminal:
				| Extract<AssistantMessageEvent, { type: "done" | "error" }>
				| undefined;
			const startedAt = performance.now();
			try {
				for await (const event of produce())
					if (event.type === "done" || event.type === "error") terminal = event;
					else out.push(event);
			} finally {
				onComplete(performance.now() - startedAt);
			}
			if (!terminal) {
				log.warn(
					{ ...context, attempt: attempt + 1 },
					"provider stream ended without terminal event",
				);
				return;
			}
			const retryError = terminal.type === "error" ? terminal.error : undefined;
			const retryable =
				terminal.type === "error" &&
				terminal.reason === "error" &&
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
function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function newAgentEntry(
	key: string,
	tools: CoreTools,
	task: TaskRuntime,
): AgentEntry {
	return {
		key,
		agent: undefined as unknown as Agent,
		tools,
		contextError: undefined,
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
	};
}
