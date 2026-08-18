/** Internal lifecycle events. Payloads are deliberately absent by default. */
type RuntimeEventBase = {
	timestamp: string;
	sessionId: string;
	[key: string]: unknown;
};

export type RuntimeEvent =
	| (RuntimeEventBase & { type: "session.started" | "session.completed" })
	| (RuntimeEventBase & {
			type: "task.started" | "task.completed";
			taskId: string;
	  })
	| (RuntimeEventBase & {
			type: "turn.started" | "turn.completed";
			taskId: string;
			turnId: number;
	  })
	| (RuntimeEventBase & {
			type: `model.request.${"started" | "completed" | "failed"}`;
			taskId: string;
			turnId: number;
			requestId: number;
	  })
	| (RuntimeEventBase & {
			type: `tool.call.${"started" | "completed" | "failed"}`;
			taskId: string;
			turnId: number;
			callId: number;
	  })
	| (RuntimeEventBase & {
			type: `skill.${"discovered" | "inspected" | "activated"}`;
			taskId: string;
	  })
	| (RuntimeEventBase & { type: "capability.snapshot.created"; taskId: string })
	| (RuntimeEventBase & {
			type: `context.assembly.${"completed" | "failed"}`;
			taskId: string;
			turnId: number;
			assemblyId: number;
	  })
	| (RuntimeEventBase & {
			type: "context.compaction.completed";
			taskId: string;
			turnId: number;
			assemblyId: number;
	  })
	| (RuntimeEventBase & {
			type: `approval.${"requested" | "resolved"}`;
			taskId: string;
			approvalId: number;
	  })
	| (RuntimeEventBase & {
			type: `subagent.${"started" | "completed" | "failed"}`;
			taskId: string;
	  });

export type RuntimeEventSink = (event: RuntimeEvent) => void;

export const noopRuntimeEventSink: RuntimeEventSink = () => {};
