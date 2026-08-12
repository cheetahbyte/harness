import type {
	ConversationRevision,
	MessageId,
	TaskId,
	TaskRuntime,
} from "./task-runtime";

export type Message = { id: MessageId; text: string };
export type QueuedTask = {
	id: string;
	kind: "follow-up" | "supersede";
	submissionWatermark: ConversationRevision;
	predecessorTaskId?: TaskId;
	requirePredecessorSuccess: boolean;
	userInput: Message;
	state: "queued" | "ready" | "blocked";
};
export type SchedulerDecision =
	| { state: "ready"; queued: QueuedTask; predecessor?: TaskRuntime }
	| { state: "blocked"; queued: QueuedTask };

export class TaskScheduler {
	private current: TaskRuntime | undefined;
	private readonly pending: QueuedTask[] = [];
	private readonly completed = new Map<TaskId, TaskRuntime>();
	private replacement: QueuedTask | undefined;
	private lastCompleted: TaskRuntime | undefined;

	activate(task: TaskRuntime): void {
		if (this.current && this.current.id !== task.id)
			throw new Error("TASK_ALREADY_ACTIVE");
		this.current = task;
	}
	enqueue(
		message: Message,
		submissionWatermark: ConversationRevision,
		options: {
			requirePredecessorSuccess?: boolean;
			predecessorTaskId?: TaskId;
		} = {},
	): QueuedTask {
		const queued = queuedTask(
			message,
			submissionWatermark,
			options.requirePredecessorSuccess ?? false,
			options.predecessorTaskId ?? this.current?.id,
		);
		this.pending.push(queued);
		return structuredClone(queued);
	}
	requestSupersede(
		activeTaskId: TaskId,
		message: Message,
		submissionWatermark: ConversationRevision,
	): { queued: QueuedTask; replaced?: QueuedTask } {
		if (this.current?.id !== activeTaskId) throw new Error("TASK_NOT_ACTIVE");
		const queued = queuedTask(
			message,
			submissionWatermark,
			false,
			activeTaskId,
			"supersede",
		);
		const replaced = this.replacement;
		this.replacement = queued;
		return {
			queued: structuredClone(queued),
			...(replaced ? { replaced: structuredClone(replaced) } : {}),
		};
	}
	settle(task: TaskRuntime): SchedulerDecision | undefined {
		if (this.current?.id !== task.id) throw new Error("TASK_NOT_ACTIVE");
		if (!task.result()) throw new Error("TASK_NOT_TERMINAL");
		this.completed.set(task.id, task);
		this.lastCompleted = task;
		while (this.completed.size > 100)
			this.completed.delete(this.completed.keys().next().value as string);
		this.current = undefined;
		return this.next();
	}
	next(): SchedulerDecision | undefined {
		if (this.current) return undefined;
		const replacement = this.replacement;
		if (replacement) {
			this.replacement = undefined;
			replacement.state = "ready";
			const predecessor = this.predecessor(replacement);
			return {
				state: "ready",
				queued: structuredClone(replacement),
				...(predecessor ? { predecessor } : {}),
			};
		}
		const queued = this.pending[0];
		if (!queued) return undefined;
		const requiredPredecessor = queued.predecessorTaskId
			? this.completed.get(queued.predecessorTaskId)?.result()?.status
			: this.lastCompleted?.result()?.status;
		if (
			queued.requirePredecessorSuccess &&
			requiredPredecessor !== "completed"
		) {
			queued.state = "blocked";
			return { state: "blocked", queued: structuredClone(queued) };
		}
		this.pending.shift();
		queued.state = "ready";
		const predecessor = this.predecessor(queued);
		return {
			state: "ready",
			queued: structuredClone(queued),
			...(predecessor ? { predecessor } : {}),
		};
	}
	resume(id: string): QueuedTask {
		const queued = this.findPending(id);
		queued.requirePredecessorSuccess = false;
		queued.state = "queued";
		return structuredClone(queued);
	}
	cancelQueued(id: string): QueuedTask {
		const index = this.pending.findIndex((queued) => queued.id === id);
		if (index < 0) throw new Error("QUEUED_TASK_NOT_FOUND");
		const [removed] = this.pending.splice(index, 1);
		if (!removed) throw new Error("QUEUED_TASK_NOT_FOUND");
		return structuredClone(removed);
	}
	replaceQueued(
		id: string,
		message: Message,
		submissionWatermark: ConversationRevision,
	): { cancelled: QueuedTask; queued: QueuedTask } {
		const index = this.pending.findIndex((queued) => queued.id === id);
		const cancelled = this.pending[index];
		if (!cancelled) throw new Error("QUEUED_TASK_NOT_FOUND");
		const queued = queuedTask(
			message,
			submissionWatermark,
			false,
			cancelled.predecessorTaskId,
		);
		this.pending[index] = queued;
		return {
			cancelled: structuredClone(cancelled),
			queued: structuredClone(queued),
		};
	}
	hasPendingSupersede(): boolean {
		return !!this.replacement;
	}
	private predecessor(queued: QueuedTask): TaskRuntime | undefined {
		return queued.predecessorTaskId
			? this.completed.get(queued.predecessorTaskId)
			: this.lastCompleted;
	}
	private findPending(id: string): QueuedTask {
		const queued = this.pending.find((candidate) => candidate.id === id);
		if (!queued) throw new Error("QUEUED_TASK_NOT_FOUND");
		return queued;
	}
}

function queuedTask(
	message: Message,
	submissionWatermark: ConversationRevision,
	requirePredecessorSuccess: boolean,
	predecessorTaskId?: TaskId,
	kind: QueuedTask["kind"] = "follow-up",
): QueuedTask {
	return {
		id: message.id,
		kind,
		submissionWatermark,
		...(predecessorTaskId ? { predecessorTaskId } : {}),
		requirePredecessorSuccess,
		userInput: structuredClone(message),
		state: "queued",
	};
}
