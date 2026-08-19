/** Internal lifecycle events. Content fields are only present when explicitly captured. */
export type RuntimeEvent = {
	type:
		| "session.started"
		| "session.completed"
		| "task.started"
		| "task.completed"
		| "turn.started"
		| "turn.completed"
		| `model.request.${"started" | "completed" | "failed"}`
		| `tool.call.${"started" | "completed" | "failed"}`
		| `skill.${"discovered" | "inspected" | "activated"}`
		| "capability.snapshot.created"
		| `context.assembly.${"completed" | "failed"}`
		| "context.prepare"
		| `context.compaction.${"started" | "completed" | "failed"}`
		| "context.recovery.completed"
		| `approval.${"requested" | "resolved"}`
		| `subagent.${"started" | "completed" | "failed"}`;
	timestamp: string;
	sessionId: string;
	taskId?: string;
	turnId?: number;
	requestId?: number;
	callId?: number;
	assemblyId?: number;
	approvalId?: number;
	status?: string;
	durationMs?: number;
	error?: string;
	provider?: string;
	model?: string;
	tool?: string;
	source?: string;
	trigger?: string;
	inputTokens?: number;
	outputTokens?: number;
	sourceTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	liveTokens?: number;
	historyTokens?: number;
	pressureStreak?: number;
	lane?: string;
	prefixAlias?: string;
	beforeTokens?: number;
	afterTokens?: number;
	headroomTokens?: number;
	retries?: number;
	stalePlan?: boolean;
	[key: string]: unknown;
};

export type RuntimeEventSink = (event: RuntimeEvent) => void;

export const noopRuntimeEventSink: RuntimeEventSink = () => {};
