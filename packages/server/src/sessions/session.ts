import { EventEmitter } from "node:events";
import type { ServerEvent } from "../../../shared/src/protocol";
import { TaskScheduler } from "./scheduler";
import type { PendingSteer, RunningTask } from "./task-runner";

type SessionEvents = { event: [event: ServerEvent, seq?: number] };

export class Session {
	readonly events = new EventEmitter<SessionEvents>();
	readonly scheduler = new TaskScheduler();
	starting?: Promise<void>;
	running?: RunningTask;
	pendingSteer?: PendingSteer;
}
