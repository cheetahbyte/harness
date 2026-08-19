import type {
	Agent,
	AgentEvent,
	AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import type {
	ImageAttachment,
	ServerEvent,
} from "../../../shared/src/protocol";
import type { ContextCompactor, ContextManager } from "../context/manager";
import { ContextBudgetError, type ContextInspection } from "../context/types";
import type { SessionStore } from "../sessions/store";
import { resolveSystemPrompt } from "../system-prompt";
import type { TaskRuntime } from "../task-runtime";
import type { RuntimeEventSink } from "../telemetry/events";
import { tokenCost } from "../token-cost";
import type { CoreTools } from "../tools";
import { detailsRecord, messageKey } from "./message";

export type QueueCallbacks = {
	onStarted: () => void;
	onFinished: () => void;
	onReplaced?: () => void;
};
export type QueuedMessage = QueueCallbacks & { message: object };
export type AgentEntry = {
	key: string;
	agent: Agent;
	tools: CoreTools;
	contextError: Error | undefined;
	compactor: ContextCompactor | undefined;
	promptGroupId: string | undefined;
	preRecorded: Set<string>;
	toolGroups: Map<string, string>;
	steering: QueuedMessage | undefined;
	queued: WeakMap<object, QueuedMessage>;
	active: QueuedMessage[];
	task: TaskRuntime;
	timing: {
		modelDurationMs: number;
		toolDurationMs: number;
		activeToolCalls: Set<string>;
		toolWindowStartedAt: number | undefined;
	};
	/** Emitter for the in-flight run; context assembly reports compaction through it. */
	emit: ((event: ServerEvent) => void) | undefined;
	sink: RuntimeEventSink | undefined;
	turnId: number;
	callIds: Map<string, number>;
	callStarted: Map<string, number>;
};

export function translateAgentEvent({
	sessionId,
	entry,
	event,
	emit,
	context,
	shrink,
	inspect,
	sink,
}: {
	sessionId: string;
	entry: AgentEntry;
	event: AgentEvent;
	emit: (event: ServerEvent) => void;
	context: ContextManager;
	shrink: () => void;
	inspect: () => ContextInspection;
	sink?: RuntimeEventSink;
}): void {
	switch (event.type) {
		case "message_start":
			handleMessageStart(
				sessionId,
				entry,
				event.message as AgentMessage,
				context,
			);
			return;
		case "turn_end":
			finishQueuedMessages(entry);
			return;
		case "message_update":
			emitMessageUpdate(event, emit);
			return;
		case "message_end":
			handleMessageEnd(sessionId, entry, event.message, context, inspect, emit);
			return;
		case "agent_end":
			handleAgentEnd(sessionId, entry, context, shrink, emit);
			return;
		case "tool_execution_start": {
			const startSource = event.toolName.startsWith("mcp__") ? "mcp" : "harnez";
			entry.callStarted.set(event.toolCallId, performance.now());
			sink?.({
				type: "tool.call.started",
				timestamp: new Date().toISOString(),
				sessionId,
				taskId: entry.task.id,
				source: startSource,
				turnId: entry.turnId,
				callId:
					entry.callIds.get(event.toolCallId) ??
					(entry.callIds.set(event.toolCallId, entry.callIds.size + 1),
					entry.callIds.size),
				tool: event.toolName,
				...(startSource === "mcp"
					? { mcpPayload: { arguments: event.args } }
					: { toolArguments: event.args }),
			});
			if (!entry.timing.activeToolCalls.size)
				entry.timing.toolWindowStartedAt = performance.now();
			entry.timing.activeToolCalls.add(event.toolCallId);
			emit({
				type: "tool-call",
				id: event.toolCallId,
				name: event.toolName,
				input: event.args,
			});
			return;
		}
		case "tool_execution_end": {
			const endSource = event.toolName.startsWith("mcp__") ? "mcp" : "harnez";
			sink?.({
				type: event.isError ? "tool.call.failed" : "tool.call.completed",
				timestamp: new Date().toISOString(),
				sessionId,
				taskId: entry.task.id,
				source: endSource,
				turnId: entry.turnId,
				callId: entry.callIds.get(event.toolCallId) ?? 0,
				tool: event.toolName,
				durationMs: Math.round(
					performance.now() -
						(entry.callStarted.get(event.toolCallId) ?? performance.now()),
				),
				...(endSource === "mcp"
					? { mcpPayload: { result: event.result } }
					: { toolResults: event.result }),
			});
			entry.timing.activeToolCalls.delete(event.toolCallId);
			entry.callIds.delete(event.toolCallId);
			entry.callStarted.delete(event.toolCallId);
			if (
				!entry.timing.activeToolCalls.size &&
				entry.timing.toolWindowStartedAt !== undefined
			) {
				entry.timing.toolDurationMs +=
					performance.now() - entry.timing.toolWindowStartedAt;
				entry.timing.toolWindowStartedAt = undefined;
			}
			emit({
				type: "tool-result",
				id: event.toolCallId,
				name: event.toolName,
				output: messageText(event.result),
				isError: event.isError,
			});
			return;
		}
		// Pi lifecycle events Harnez does not surface.
		case "agent_start":
		case "turn_start":
		case "tool_execution_update":
			return;
		default:
			// Unknown future events are ignored rather than crashing the run.
			return;
	}
}

function handleMessageStart(
	sessionId: string,
	entry: AgentEntry,
	message: AgentMessage,
	context: ContextManager,
): void {
	const queued = entry.queued.get(message as object);
	if (!queued) return;
	entry.queued.delete(queued.message);
	if (entry.steering === queued) entry.steering = undefined;
	entry.active.push(queued);
	entry.promptGroupId = crypto.randomUUID();
	recordAgentMessage({ sessionId, entry, message, context });
	entry.preRecorded.add(messageKey(message));
	queued.onStarted();
}
function finishQueuedMessages(entry: AgentEntry): void {
	for (const queued of entry.active.splice(0)) queued.onFinished();
}
function emitMessageUpdate(
	event: Extract<AgentEvent, { type: "message_update" }>,
	emit: (event: ServerEvent) => void,
): void {
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
function handleMessageEnd(
	sessionId: string,
	entry: AgentEntry,
	message: AgentMessage,
	context: ContextManager,
	inspect: () => ContextInspection,
	emit: (event: ServerEvent) => void,
): void {
	if (!entry.preRecorded.delete(messageKey(message)))
		recordAgentMessage({ sessionId, entry, message, context });
	if (message.role !== "assistant") return;
	emit({
		type: "usage",
		input: message.usage.input,
		output: message.usage.output,
		cacheRead: message.usage.cacheRead,
		cacheWrite: message.usage.cacheWrite,
		totalTokens: message.usage.totalTokens,
		costUsd: message.usage.cost.total,
	});
	emitContextStatus(inspect, emit);
	if (message.errorMessage)
		emit({ type: "error", message: message.errorMessage });
}

/**
 * Reports the working set against the whole recorded history. Both figures come
 * from `tokenCost`'s chars/4 estimate, so the ratio is internally consistent
 * even though neither number matches provider-reported usage.
 */
function emitContextStatus(
	inspect: () => ContextInspection,
	emit: (event: ServerEvent) => void,
): void {
	const inspection = inspect();
	if (inspection.budget === undefined || inspection.target === undefined)
		return;
	emit({
		type: "context-status",
		liveTokens: inspection.estimatedTokens,
		historyTokens: inspection.historyTokens,
		parkedObservations: inspection.parkedObservations,
		budget: inspection.budget,
		target: inspection.target,
	});
}
function handleAgentEnd(
	sessionId: string,
	entry: AgentEntry,
	context: ContextManager,
	shrink: () => void,
	emit: (event: ServerEvent) => void,
): void {
	if (entry.promptGroupId)
		context.completeGroup(sessionId, entry.promptGroupId);
	shrink();
	entry.promptGroupId = undefined;
	if (!entry.contextError) return;
	emit(
		entry.contextError instanceof ContextBudgetError
			? {
					type: "context-budget-error",
					estimatedTokens: entry.contextError.estimatedTokens,
					budget: entry.contextError.budget,
				}
			: { type: "error", message: entry.contextError.message },
	);
}

export function recordAgentMessage({
	sessionId,
	entry,
	message,
	context,
}: {
	sessionId: string;
	entry: AgentEntry;
	message: AgentMessage;
	context: ContextManager;
}): void {
	if (entry.task.state !== "running" && message.role !== "user") return;
	const messageTokenCost = tokenCost(message, 1);
	if (message.role === "assistant") {
		const calls = message.content.filter(
			(content) => content.type === "toolCall",
		);
		const groupId = calls.length ? crypto.randomUUID() : entry.promptGroupId;
		for (const call of calls) entry.toolGroups.set(call.id, groupId as string);
		context.record({
			sessionId,
			kind: "assistant",
			payload: message,
			tokenCost: messageTokenCost,
			lifecycle: "active",
			reason: "Pi assistant message",
			...(groupId ? { groupId } : {}),
		});
		return;
	}
	if (message.role === "toolResult") {
		const groupId = entry.toolGroups.get(message.toolCallId);
		entry.toolGroups.delete(message.toolCallId);
		const payload = externalizeToolResult({
			sessionId,
			message,
			tools: entry.tools,
			context,
		});
		const archivedObservationId = observationId(payload);
		const compactPayload = compactToolResult(payload);
		context.record({
			sessionId,
			kind: "tool-result",
			payload,
			compactPayload,
			tokenCost: messageTokenCost,
			compactTokenCost: tokenCost(compactPayload, 1),
			lifecycle: "active",
			reason: "Pi tool result",
			source: {
				toolCallId: message.toolCallId,
				...entry.tools.contextMetadata(message.toolName),
				...(archivedObservationId
					? { observationId: archivedObservationId }
					: {}),
				isError: message.isError,
			},
			...(groupId ? { groupId } : {}),
		});
		return;
	}
	context.record({
		sessionId,
		kind: "user",
		payload: message,
		tokenCost: messageTokenCost,
		lifecycle: "pinned",
		reason: "user-authored message",
		...(entry.promptGroupId ? { groupId: entry.promptGroupId } : {}),
	});
}

export function managedMessages({
	sessionId,
	model,
	task,
	store,
	context,
	contextOptions,
	emit,
	turnId,
}: {
	sessionId: string;
	model: Model<Api>;
	task?: TaskRuntime;
	store: SessionStore;
	context: ContextManager;
	contextOptions: (model: Model<Api>) => {
		budget: number;
		target: number;
		overheadTokens: number;
	};
	emit?: ((event: ServerEvent) => void) | undefined;
	turnId?: number;
}): AgentMessage[] {
	const capabilityItems = task?.context.items() ?? [];
	if (store.contextItems(sessionId).length === 0 && !capabilityItems.length)
		return [];
	const dynamic: AgentMessage[] = [
		...(task?.predecessorDigest
			? [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: `Advisory predecessor control-plane digest:\n${JSON.stringify(task.predecessorDigest)}`,
							},
						],
						timestamp: new Date(task.startedAt).getTime(),
					},
				]
			: []),
		...capabilityItems.map((item): AgentMessage => ({
			role: "user",
			content: [
				{
					type: "text",
					text: `Task capability context (${item.capability.id}):\n${typeof item.content === "string" ? item.content : JSON.stringify(item.content)}`,
				},
			],
			timestamp: task ? new Date(task.startedAt).getTime() : Date.now(),
		})),
	];
	const options = contextOptions(model);
	options.overheadTokens += dynamic.length ? tokenCost(dynamic) : 0;
	const assembly =
		task?.submissionWatermark !== undefined &&
		task.taskStartSequence !== undefined
			? context.assembleTask(sessionId, {
					...options,
					taskId: task.id,
					...(turnId === undefined ? {} : { turnId }),
					trigger: "prepare-next-turn",
					submissionWatermark: task.submissionWatermark,
					taskStartSequence: task.taskStartSequence,
					predecessorTerminalIds: task.predecessorTerminalMessageIds,
				})
			: context.assemble(sessionId, {
					...options,
					...(task ? { taskId: task.id } : {}),
					...(turnId === undefined ? {} : { turnId }),
				});
	if (emit && assembly.evictedIds.length)
		emit({
			type: "context-compaction",
			evictedCount: assembly.evictedIds.length,
			tokensBefore: assembly.tokensBefore,
			tokensAfter: assembly.tokensAfter,
			episodesArchived: assembly.episodesArchived,
		});
	const messages = assembly.payloads as AgentMessage[];
	const lastUser = messages.findLastIndex((message) => message.role === "user");
	return dropOrphanToolResults(
		lastUser < 0
			? [...messages, ...dynamic]
			: [
					...messages.slice(0, lastUser),
					...dynamic,
					...messages.slice(lastUser),
				],
	);
}

/** Async admission path used at prompt boundaries; this is where LLM compaction runs. */
export async function managedMessagesAsync({
	sessionId,
	model,
	task,
	context,
	contextOptions,
	signal,
	compactor,
}: {
	sessionId: string;
	model: Model<Api>;
	task: TaskRuntime;
	context: ContextManager;
	contextOptions: (model: Model<Api>) => {
		budget: number;
		target: number;
		overheadTokens: number;
	};
	signal: AbortSignal;
	compactor?: ContextCompactor;
}): Promise<AgentMessage[]> {
	const capabilityItems = task.context.items();
	const dynamic: AgentMessage[] = [
		...(task.predecessorDigest
			? [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: `Advisory predecessor control-plane digest:\n${JSON.stringify(task.predecessorDigest)}`,
							},
						],
						timestamp: new Date(task.startedAt).getTime(),
					},
				]
			: []),
		...capabilityItems.map((item): AgentMessage => ({
			role: "user",
			content: [
				{
					type: "text",
					text: `Task capability context (${item.capability.id}):\n${typeof item.content === "string" ? item.content : JSON.stringify(item.content)}`,
				},
			],
			timestamp: new Date(task.startedAt).getTime(),
		})),
	];
	const options = contextOptions(model);
	const prepared = await context.prepareTurn({
		sessionId,
		taskId: task.id,
		laneId: "main",
		capabilityMessages: [],
		fixedMessages: dynamic,
		tools: [],
		budget: options.budget,
		overheadTokens: options.overheadTokens,
		...(compactor ? { compactor } : {}),
		signal,
	});
	return dropOrphanToolResults(prepared.messages as AgentMessage[]);
}

function dropOrphanToolResults(messages: AgentMessage[]): AgentMessage[] {
	const pending = new Set<string>();
	return messages.filter((message) => {
		if (message.role === "assistant") {
			pending.clear();
			for (const content of message.content)
				if (content.type === "toolCall") pending.add(content.id);
			return true;
		}
		if (message.role === "user") {
			pending.clear();
			return true;
		}
		if (message.role !== "toolResult") return true;
		return pending.delete(message.toolCallId);
	});
}

export function ensureSystem({
	sessionId,
	store,
	context,
	workspace,
}: {
	sessionId: string;
	store: SessionStore;
	context: ContextManager;
	workspace: string;
}): string {
	const existing = store
		.contextItems(sessionId)
		.find((item) => item.kind === "system");
	if (existing) {
		if (typeof existing.payload !== "string")
			throw new Error(`session ${sessionId} has an invalid system prompt`);
		return existing.payload;
	}
	const systemPrompt = resolveSystemPrompt(workspace);
	context.record({
		sessionId,
		kind: "system",
		payload: systemPrompt,
		tokenCost: tokenCost(systemPrompt, 1),
		lifecycle: "pinned",
		reason: "Harnez system prompt",
	});
	return systemPrompt;
}

export function queueMessage(
	text: string,
	callbacks: QueueCallbacks,
	images: readonly ImageAttachment[] = [],
): QueuedMessage {
	return {
		...callbacks,
		message: {
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
		},
	};
}
function externalizeToolResult({
	sessionId,
	message,
	tools,
	context,
}: {
	sessionId: string;
	message: Extract<AgentMessage, { role: "toolResult" }>;
	tools: CoreTools;
	context: ContextManager;
}): Extract<AgentMessage, { role: "toolResult" }> {
	if (observationId(message)) return message;
	const observation = context.recordObservation(
		sessionId,
		messageText(message),
		{
			toolCallId: message.toolCallId,
			...tools.contextMetadata(message.toolName),
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
function observationId(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): string | undefined {
	const id = detailsRecord(message.details)["observationId"];
	return typeof id === "string" ? id : undefined;
}
function messageText(
	message:
		| Extract<AgentMessage, { role: "toolResult" }>
		| { content: readonly { type: string; text?: string }[] },
): string {
	return message.content
		.flatMap((content) => (content.type === "text" ? [content.text ?? ""] : []))
		.join("");
}
