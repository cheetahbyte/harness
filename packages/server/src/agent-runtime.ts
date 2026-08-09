import {
	Agent,
	type AgentEvent,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { ServerEvent } from "../../shared/src/protocol";
import {
	type HarnessModelConfig,
	HarnessProviderError,
	type JsonCredentialStore,
	providerModels,
} from "./provider";
import type { CoreTools, ToolRequest } from "./tools";

interface AgentRuntime {
	run(
		sessionId: string,
		text: string,
		config: HarnessModelConfig | undefined,
		signal: AbortSignal,
		emit: (event: ServerEvent) => void,
	): Promise<void>;
	steer(sessionId: string, text: string, callbacks: QueueCallbacks): boolean;
	followUp(sessionId: string, text: string, callbacks: QueueCallbacks): boolean;
	forget(sessionId: string): void;
}

type QueueCallbacks = {
	onStarted: () => void;
	onFinished: () => void;
	onReplaced?: () => void;
};
type QueuedMessage = QueueCallbacks & { message: object };
type AgentEntry = {
	key: string;
	agent: Agent;
	steering?: QueuedMessage;
	queued: WeakMap<object, QueuedMessage>;
	active: QueuedMessage[];
};

/** Pi is contained here: server code only sees Harness events and model configuration. */
export class HarnessAgentRuntime implements AgentRuntime {
	private readonly agents = new Map<string, AgentEntry>();
	constructor(
		private readonly tools: CoreTools,
		private readonly credentials: JsonCredentialStore,
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
			const agent = new Agent({
				initialState: {
					model,
					thinkingLevel: "medium",
					systemPrompt:
						"You are Harness, a coding agent. Use the provided tools to inspect and change the current workspace.",
					tools: this.agentTools(),
				},
				streamFn: (_unused, context, options) =>
					models.streamSimple(model, context, options),
				toolExecution: "sequential",
			});
			const created: AgentEntry = {
				key,
				agent,
				queued: new WeakMap(),
				active: [],
			};
			agent.subscribe((event) => this.translate(created, event, emit));
			this.agents.set(sessionId, created);
			entry = created;
		}
		const abort = () => entry?.agent.abort();
		signal.addEventListener("abort", abort, { once: true });
		try {
			await entry.agent.prompt(text);
		} catch (error) {
			if (!signal.aborted) throw normalizeProviderError(error);
		} finally {
			signal.removeEventListener("abort", abort);
		}
	}

	steer(sessionId: string, text: string, callbacks: QueueCallbacks): boolean {
		const entry = this.agents.get(sessionId);
		if (!entry?.agent.state.isStreaming) return false;
		if (entry.steering) entry.steering.onReplaced?.();
		entry.agent.clearSteeringQueue();
		const queued = this.queue(text, callbacks);
		entry.steering = queued;
		entry.queued.set(queued.message, queued);
		entry.agent.steer(queued.message as never);
		return true;
	}

	followUp(
		sessionId: string,
		text: string,
		callbacks: QueueCallbacks,
	): boolean {
		const entry = this.agents.get(sessionId);
		if (!entry?.agent.state.isStreaming) return false;
		const queued = this.queue(text, callbacks);
		entry.queued.set(queued.message, queued);
		entry.agent.followUp(queued.message as never);
		return true;
	}

	forget(sessionId: string): void {
		this.agents.delete(sessionId);
	}

	private agentTools(): AgentTool[] {
		return (["read", "write", "edit", "bash"] as const).map((name) => ({
			name,
			label: name,
			description: toolDescription(name),
			parameters: toolSchema(name),
			execute: async (id, input, signal) => ({
				content: [
					{
						type: "text",
						text: await this.tools.execute(
							{ name, input: input as Record<string, unknown> },
							signal ?? new AbortController().signal,
						),
					},
				],
				details: { id },
			}),
		}));
	}

	private translate(
		entry: AgentEntry,
		event: AgentEvent,
		emit: (event: ServerEvent) => void,
	): void {
		if (event.type === "message_start") {
			const queued = entry.queued.get(event.message as object);
			if (queued) {
				entry.queued.delete(queued.message);
				if (entry.steering === queued) entry.steering = undefined;
				entry.active.push(queued);
				queued.onStarted();
			}
		}
		if (event.type === "turn_end") {
			for (const queued of entry.active.splice(0)) queued.onFinished();
		}
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
		if (event.type === "message_end" && event.message.role === "assistant") {
			const usage = event.message.usage;
			emit({
				type: "usage",
				input: usage.input,
				output: usage.output,
				cacheRead: usage.cacheRead,
				cacheWrite: usage.cacheWrite,
				totalTokens: usage.totalTokens,
			});
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

	private queue(text: string, callbacks: QueueCallbacks): QueuedMessage {
		return {
			...callbacks,
			message: {
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			},
		};
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
