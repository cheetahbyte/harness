import {
	Agent,
	type AgentEvent,
	type AgentTool,
} from "@earendil-works/pi-agent-core";
import type {
	AssistantMessageEvent,
	AssistantMessageEventStream,
	CredentialStore,
	Models,
} from "@earendil-works/pi-ai";
import {
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	Type,
} from "@earendil-works/pi-ai";
import type { ModelConfig, ServerEvent } from "../../shared/src/protocol";
import { log } from "./logger";
import { HarnessProviderError, providerModels } from "./provider";
import type { CoreTools, ToolRequest } from "./tools";

type QueueCallbacks = {
	onStarted: () => void;
	onFinished: () => void;
	onReplaced?: () => void;
};
type QueuedMessage = QueueCallbacks & { message: object };
type AgentEntry = {
	key: string;
	agent: Agent;
	steering: QueuedMessage | undefined;
	queued: WeakMap<object, QueuedMessage>;
	active: QueuedMessage[];
};

/** Pi is contained here: server code only sees Harness events and model configuration. */
export class HarnessAgentRuntime {
	private readonly agents = new Map<string, AgentEntry>();
	constructor(
		private readonly credentials: CredentialStore,
		private readonly models: Models,
	) {}

	async run(
		sessionId: string,
		text: string,
		config: ModelConfig | undefined,
		tools: CoreTools,
		signal: AbortSignal,
		emit: (event: ServerEvent) => void,
	): Promise<void> {
		if (!config)
			throw new HarnessProviderError(
				"no model configured; use /model",
				"configuration",
			);
		const key = JSON.stringify(config);
		let entry = this.agents.get(sessionId);
		if (!entry || entry.key !== key) {
			const { models, model } = providerModels(
				config,
				this.credentials,
				this.models,
			);
			const agent = new Agent({
				initialState: {
					model,
					thinkingLevel: "medium",
					systemPrompt:
						"You are Harness, a coding agent. Use the provided tools to inspect and change the current workspace.",
					tools: this.agentTools(tools),
				},
				streamFn: (_unused, context, options) =>
					streamWithRetry(
						() => models.streamSimple(model, context, options),
						options?.signal,
						{ sessionId, provider: config.provider, model: config.model },
					),
				toolExecution: "sequential",
			});
			const created: AgentEntry = {
				key,
				agent,
				queued: new WeakMap(),
				active: [],
				steering: undefined,
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
			log.error({ err: error, sessionId }, "agent prompt failed");
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

	private agentTools(tools: CoreTools): AgentTool[] {
		return (["read", "write", "edit", "bash"] as const).map((name) => ({
			name,
			label: name,
			description: toolDescription(name),
			parameters: toolSchema(name),
			execute: async (id, input, signal) => ({
				content: [
					{
						type: "text",
						text: await tools.execute(
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
}

function normalizeProviderError(error: unknown): HarnessProviderError {
	return error instanceof HarnessProviderError
		? error
		: new HarnessProviderError(
				error instanceof Error ? error.message : String(error),
			);
}
const MAX_STREAM_RETRIES = 3;
const STREAM_RETRY_BASE_DELAY_MS = 500;

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) return resolve();
		const timeout = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * Providers occasionally drop the connection before producing any output (e.g. the
 * openai-codex WebSocket transport reporting "socket connection was closed unexpectedly"
 * or a bare connect timeout). Silently retry those with backoff, since the request
 * never reached the model. Once any content has streamed, a dropped connection is no
 * longer safely retryable, so it is forwarded as-is.
 */
function streamWithRetry(
	produce: () => AssistantMessageEventStream,
	signal: AbortSignal | undefined,
	context: { sessionId: string; provider: string; model: string },
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
			for await (const event of produce())
				if (event.type === "done" || event.type === "error") terminal = event;
				else out.push(event);
			if (!terminal) {
				log.warn(
					{ ...context, attempt: attempt + 1 },
					"provider stream ended without terminal event",
				);
				return;
			}
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
							error: terminal.error.errorMessage,
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
					error:
						terminal.type === "error" ? terminal.error.errorMessage : undefined,
				},
				"provider stream failed; retrying",
			);
			await sleep(delayMs, signal);
			if (signal?.aborted) return out.push(terminal);
		}
	})();
	return out;
}

function toolDescription(name: ToolRequest["name"]): string {
	switch (name) {
		case "read":
			return "Read a text file in the workspace.";
		case "write":
			return "Write a text file in the workspace.";
		case "edit":
			return "Replace exact text in a file.";
		case "bash":
			return "Run a shell command in the workspace.";
	}
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
