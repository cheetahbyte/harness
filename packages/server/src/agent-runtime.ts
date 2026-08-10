import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
import type { ServerEvent } from "../../shared/src/protocol";
import type { ContextManager } from "./context-manager";
import {
	type HarnessModelConfig,
	HarnessProviderError,
	type JsonCredentialStore,
	providerModels,
} from "./provider";
import type { SessionStore } from "./session-store";
import type { CoreTools, ToolRequest } from "./tools";

interface AgentRuntime {
	run(
		sessionId: string,
		text: string,
		config: HarnessModelConfig | undefined,
		signal: AbortSignal,
		emit: (event: ServerEvent) => void,
	): Promise<void>;
	forget(sessionId: string): void;
	inspect(sessionId: string): ReturnType<ContextManager["inspect"]>;
}

type AgentEntry = {
	key: string;
	agent: Agent;
	contextError?: Error;
	promptGroupId?: string;
	preRecorded: Set<string>;
	toolGroups: Map<string, string>;
};

const SYSTEM_PROMPT =
	"You are Harness, a coding agent. Use the provided tools to inspect and change the current workspace. Use episode boundaries for non-trivial work: close explorations with a concise conclusion, then make actions depend on the completed exploration IDs they use. Pin durable decisions and constraints with pin_context.";
const DEFAULT_CONTEXT_BUDGET = 80_000;
const RECALL_DESCRIPTION =
	"Read an exact slice from an archived observation:// reference.";
const PIN_DESCRIPTION = "Keep a short instruction in all future model context.";
const EPISODE_DESCRIPTION =
	"Start or end one semantic work episode. Actions depend on completed exploration IDs.";
const TOOL_OVERHEAD_TOKENS = estimateTokens({
	tools: [
		...(["read", "write", "edit", "bash"] as const).map((name) => ({
			name,
			description: toolDescription(name),
			parameters: toolSchema(name),
		})),
		{
			name: "recall_observation",
			description: RECALL_DESCRIPTION,
			parameters: recallSchema(),
		},
		{
			name: "pin_context",
			description: PIN_DESCRIPTION,
			parameters: pinSchema(),
		},
		{
			name: "episode",
			description: EPISODE_DESCRIPTION,
			parameters: episodeSchema(),
		},
	],
});

/** Pi is contained here: server code only sees Harness events and model configuration. */
export class HarnessAgentRuntime implements AgentRuntime {
	private readonly agents = new Map<string, AgentEntry>();
	constructor(
		private readonly tools: CoreTools,
		private readonly credentials: JsonCredentialStore,
		private readonly store: SessionStore,
		private readonly context: ContextManager,
		private readonly contextBudget = DEFAULT_CONTEXT_BUDGET,
	) {}

	async run(
		sessionId: string,
		text: string,
		config: HarnessModelConfig | undefined,
		signal: AbortSignal,
		emit: (event: ServerEvent) => void,
	): Promise<void> {
		const request = parseTool(text);
		if (request) return this.runTool(request, signal, emit);
		if (!config)
			throw new HarnessProviderError(
				"no model configured; use /model <openai-codex|openai-compatible> <model> [base-url]",
				"configuration",
			);
		const key = JSON.stringify(config);
		let entry = this.agents.get(sessionId);
		if (!entry || entry.key !== key) {
			const { models, model } = providerModels(config, this.credentials);
			const created = this.createAgent(sessionId, key, model, models);
			created.agent.subscribe((event) =>
				this.translate(sessionId, created, event, emit),
			);
			this.agents.set(sessionId, created);
			entry = created;
		}
		const message: AgentMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
		entry.promptGroupId = crypto.randomUUID();
		this.recordMessage(sessionId, entry, message);
		try {
			this.managedMessages(sessionId, entry.agent.state.model);
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
			if (!signal.aborted) throw normalizeProviderError(error);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}

	forget(sessionId: string): void {
		this.agents.delete(sessionId);
	}

	inspect(sessionId: string): ReturnType<ContextManager["inspect"]> {
		const model = this.agents.get(sessionId)?.agent.state.model;
		const options = model
			? this.contextOptions(model)
			: {
					budget: this.contextBudget,
					target: Math.floor(this.contextBudget * 0.8),
					overheadTokens: TOOL_OVERHEAD_TOKENS,
				};
		return this.context.inspect(sessionId, options);
	}

	private createAgent(
		sessionId: string,
		key: string,
		model: Model<Api>,
		models: ReturnType<typeof providerModels>["models"],
	): AgentEntry {
		this.ensureSystem(sessionId);
		const entry: AgentEntry = {
			key,
			agent: undefined as unknown as Agent,
			contextError: undefined,
			preRecorded: new Set(),
			toolGroups: new Map(),
		};
		const managed = (): AgentMessage[] => {
			try {
				entry.contextError = undefined;
				return this.managedMessages(sessionId, model);
			} catch (error) {
				entry.contextError = asError(error);
				return [];
			}
		};
		const agent = new Agent({
			initialState: {
				model,
				thinkingLevel: "medium",
				systemPrompt: SYSTEM_PROMPT,
				tools: this.agentTools(sessionId, model),
				messages: this.managedMessages(sessionId, model),
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
				return models.streamSimple(model, requestContext, options);
			},
			toolExecution: "sequential",
		});
		entry.agent = agent;
		return entry;
	}

	private agentTools(sessionId: string, model: Model<Api>): AgentTool[] {
		const core: AgentTool[] = (["read", "write", "edit", "bash"] as const).map(
			(name) => ({
				name,
				label: name,
				description: toolDescription(name),
				parameters: toolSchema(name),
				execute: async (id, input, signal) => {
					const output = await this.tools.execute(
						{ name, input: input as Record<string, unknown> },
						signal ?? new AbortController().signal,
					);
					const observation = this.context.recordObservation(
						sessionId,
						output,
						{
							toolCallId: id,
							toolName: name,
						},
					);
					return {
						content: [
							{
								type: "text" as const,
								text: previewOutput(
									output,
									observation.id,
									this.previewLimit(model),
								),
							},
						],
						details: { id, observationId: observation.id },
					};
				},
			}),
		);
		return [
			...core,
			{
				name: "recall_observation",
				label: "recall observation",
				description: RECALL_DESCRIPTION,
				parameters: recallSchema(),
				execute: async (_id, input) => {
					const { reference } = input as { reference: string };
					const result = this.context.recall(sessionId, reference);
					return {
						content: [{ type: "text", text: result.text }],
						details: result,
					};
				},
			},
			{
				name: "pin_context",
				label: "pin context",
				description: PIN_DESCRIPTION,
				parameters: pinSchema(),
				execute: async (_id, input) => {
					const { kind, text } = input as {
						kind: "decision" | "constraint";
						text: string;
					};
					const item = this.context.pin(
						sessionId,
						kind,
						text,
						this.contextOptions(model),
					);
					return {
						content: [{ type: "text", text: `Pinned context: ${item.id}` }],
						details: { id: item.id },
					};
				},
			},
			{
				name: "episode",
				label: "episode",
				description: EPISODE_DESCRIPTION,
				parameters: episodeSchema(),
				execute: async (_id, input) => {
					const request = input as EpisodeInput;
					const episode =
						request.action === "start"
							? this.context.startEpisode(sessionId, request)
							: this.context.endEpisode(sessionId, request.conclusion);
					return {
						content: [
							{
								type: "text" as const,
								text: `${episode.state} ${episode.kind} episode ${episode.name} (${episode.id})`,
							},
						],
						details: episode,
					};
				},
			},
		];
	}

	private async translate(
		sessionId: string,
		entry: AgentEntry,
		event: AgentEvent,
		emit: (event: ServerEvent) => void,
	): Promise<void> {
		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update.type === "text_delta")
				emit({ type: "assistant-delta", text: update.delta });
			if (update.type === "thinking_delta")
				emit({ type: "assistant-reasoning-delta", text: update.delta });
			if (update.type === "error" && update.reason !== "aborted")
				emit({
					type: "error",
					message: update.error.errorMessage ?? "provider request failed",
				});
		}
		if (event.type === "message_end") {
			if (!entry.preRecorded.delete(messageKey(event.message)))
				this.recordMessage(sessionId, entry, event.message);
			if (event.message.role === "assistant") {
				const usage = event.message.usage;
				emit({
					type: "usage",
					input: usage.input,
					output: usage.output,
					cacheRead: usage.cacheRead,
					cacheWrite: usage.cacheWrite,
					totalTokens: usage.totalTokens,
				});
				if (event.message.errorMessage)
					emit({ type: "error", message: event.message.errorMessage });
			}
		}
		if (event.type === "agent_end") {
			if (entry.promptGroupId)
				this.context.completeGroup(sessionId, entry.promptGroupId);
			this.shrink(sessionId, entry);
			entry.promptGroupId = undefined;
			if (entry.contextError)
				emit({ type: "error", message: entry.contextError.message });
		}
		if (event.type === "tool_execution_start")
			emit({
				type: "tool-call",
				id: event.toolCallId,
				name: event.toolName,
				input: event.args,
			});
		if (event.type === "tool_execution_end")
			emit({
				type: "tool-result",
				id: event.toolCallId,
				name: event.toolName,
				output: event.result.content
					.map((content: { type: string; text?: string }) => content.text ?? "")
					.join(""),
				isError: event.isError,
			});
	}

	private recordMessage(
		sessionId: string,
		entry: AgentEntry,
		message: AgentMessage,
	): void {
		const tokenCost = estimateTokens(message);
		if (message.role === "assistant") {
			const calls = message.content.filter(
				(content) => content.type === "toolCall",
			);
			const groupId = calls.length ? crypto.randomUUID() : entry.promptGroupId;
			for (const call of calls)
				entry.toolGroups.set(call.id, groupId as string);
			this.context.record({
				sessionId,
				kind: "assistant",
				payload: message,
				tokenCost,
				lifecycle: "active",
				reason: "Pi assistant message",
				...(groupId ? { groupId } : {}),
			});
			return;
		}
		if (message.role === "toolResult") {
			const groupId = entry.toolGroups.get(message.toolCallId);
			entry.toolGroups.delete(message.toolCallId);
			const payload = this.externalizeToolResult(sessionId, message);
			const archivedObservationId = observationId(payload);
			const compactPayload = compactToolResult(payload);
			this.context.record({
				sessionId,
				kind: "tool-result",
				payload,
				compactPayload,
				tokenCost,
				compactTokenCost: estimateTokens(compactPayload),
				lifecycle: "active",
				reason: "Pi tool result",
				source: {
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					...(archivedObservationId
						? { observationId: archivedObservationId }
						: {}),
					isError: message.isError,
				},
				...(groupId ? { groupId } : {}),
			});
			return;
		}
		this.context.record({
			sessionId,
			kind: "user",
			payload: message,
			tokenCost,
			lifecycle: "pinned",
			reason: "user-authored message",
			...(entry.promptGroupId ? { groupId: entry.promptGroupId } : {}),
		});
	}

	private externalizeToolResult(
		sessionId: string,
		message: Extract<AgentMessage, { role: "toolResult" }>,
	): Extract<AgentMessage, { role: "toolResult" }> {
		if (observationId(message)) return message;
		const observation = this.context.recordObservation(
			sessionId,
			messageText(message),
			{
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
			},
		);
		return {
			...message,
			details: {
				...detailsRecord(message.details),
				observationId: observation.id,
			},
		};
	}

	private managedMessages(
		sessionId: string,
		model: Model<Api>,
	): AgentMessage[] {
		if (this.store.contextItems(sessionId).length === 0) return [];
		const options = this.contextOptions(model);
		const assembly = this.context.assemble(sessionId, options);
		return assembly.payloads as AgentMessage[];
	}

	private ensureSystem(sessionId: string): void {
		if (
			this.store.contextItems(sessionId).some((item) => item.kind === "system")
		)
			return;
		this.context.record({
			sessionId,
			kind: "system",
			payload: SYSTEM_PROMPT,
			tokenCost: estimateTokens(SYSTEM_PROMPT),
			lifecycle: "pinned",
			reason: "Harness system prompt",
		});
	}

	private contextOptions(model: Model<Api>): {
		budget: number;
		target: number;
		overheadTokens: number;
	} {
		const hardInput = model.contextWindow - model.maxTokens;
		if (!Number.isFinite(hardInput) || hardInput <= 0)
			throw new HarnessProviderError(
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
			entry.agent.state.messages = this.managedMessages(
				sessionId,
				entry.agent.state.model,
			);
		} catch (error) {
			entry.contextError = asError(error);
		}
	}

	private async runTool(
		request: ToolRequest,
		signal: AbortSignal,
		emit: (event: ServerEvent) => void,
	): Promise<void> {
		const id = crypto.randomUUID();
		emit({ type: "tool-call", id, name: request.name, input: request.input });
		try {
			emit({
				type: "tool-result",
				id,
				name: request.name,
				output: await this.tools.execute(request, signal),
			});
		} catch (error) {
			emit({
				type: "tool-result",
				id,
				name: request.name,
				output: error instanceof Error ? error.message : String(error),
				isError: true,
			});
		}
	}
}

function normalizeProviderError(error: unknown): HarnessProviderError {
	return error instanceof HarnessProviderError
		? error
		: new HarnessProviderError(
				error instanceof Error ? error.message : String(error),
			);
}
function toolDescription(name: ToolRequest["name"]): string {
	return {
		read: "Read a text file in the workspace.",
		write: "Write a text file in the workspace.",
		edit: "Replace exact text in a file.",
		bash: "Run a shell command in the workspace.",
	}[name];
}
function toolSchema(name: ToolRequest["name"]) {
	const path = Type.String({ minLength: 1 });
	return name === "read"
		? Type.Object({ path })
		: name === "write"
			? Type.Object({ path, content: Type.String() })
			: name === "edit"
				? Type.Object({ path, oldText: Type.String(), newText: Type.String() })
				: Type.Object({ command: Type.String({ minLength: 1 }) });
}
function recallSchema() {
	return Type.Object({ reference: Type.String({ minLength: 1 }) });
}
function pinSchema() {
	return Type.Object({
		kind: Type.Union([Type.Literal("decision"), Type.Literal("constraint")]),
		text: Type.String({ minLength: 1 }),
	});
}
type EpisodeInput =
	| {
			action: "start";
			name: string;
			kind: "exploration" | "action";
			dependencies?: string[];
	  }
	| { action: "end"; conclusion?: string };
function episodeSchema() {
	return Type.Union([
		Type.Object({
			action: Type.Literal("start"),
			name: Type.String({ minLength: 1 }),
			kind: Type.Union([Type.Literal("exploration"), Type.Literal("action")]),
			dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		}),
		Type.Object({
			action: Type.Literal("end"),
			conclusion: Type.Optional(Type.String({ minLength: 1 })),
		}),
	]);
}
function parseTool(text: string): ToolRequest | undefined {
	const [head, ...body] = text.split("\n");
	const [command, path] = head.trim().split(/\s+/, 2);
	if (command === "/read" && path) return { name: "read", input: { path } };
	if (command === "/bash")
		return { name: "bash", input: { command: text.slice(head.length).trim() } };
	if (command === "/write" && path)
		return { name: "write", input: { path, content: body.join("\n") } };
	if (command === "/edit" && path) {
		const divider = body.indexOf("---");
		if (divider >= 0)
			return {
				name: "edit",
				input: {
					path,
					oldText: body.slice(0, divider).join("\n"),
					newText: body.slice(divider + 1).join("\n"),
				},
			};
	}
}

function estimateTokens(value: unknown): number {
	return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
}

function messageKey(message: AgentMessage): string {
	return JSON.stringify(message);
}

function compactToolResult(
	message: Extract<AgentMessage, { role: "toolResult" }>,
) {
	const id = observationId(message);
	if (!id) throw new Error("Tool result has no observation");
	return {
		role: "user" as const,
		timestamp: message.timestamp,
		content: [
			{
				type: "text" as const,
				text: `Earlier ${message.toolName} output was compacted. Full output: observation://${id}`,
			},
		],
	};
}

function previewOutput(output: string, id: string, limit: number): string {
	if (output.length <= limit) return output;
	const marker = `\n\n[output truncated; full output: observation://${id}]\n\n`;
	const visible = Math.max(0, limit - marker.length);
	const head = Math.ceil(visible / 2);
	return `${output.slice(0, head)}${marker}${output.slice(output.length - (visible - head))}`;
}

function observationId(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): string | undefined {
	const id = detailsRecord(message.details).observationId;
	return typeof id === "string" ? id : undefined;
}

function detailsRecord(details: unknown): Record<string, unknown> {
	return typeof details === "object" &&
		details !== null &&
		!Array.isArray(details)
		? (details as Record<string, unknown>)
		: {};
}

function messageText(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): string {
	return message.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("");
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
