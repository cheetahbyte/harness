import type { ContextManager } from "../context/manager";
import type {
	PublicSubagentRecord,
	SubagentResult,
	SubagentState,
} from "../context/types";
import type { SessionStore } from "../sessions/store";
import type { TaskRuntime } from "../task-runtime";
import type { ResolvedAgentProfile } from "./profiles";

export const MAX_CONCURRENT_SUBAGENTS = 16;

export type SubagentExecutionRequest = {
	sessionId: string;
	agentId: string;
	laneId: string;
	task: string;
	profile: ResolvedAgentProfile;
	signal: AbortSignal;
	onRuntime: (task: TaskRuntime) => void;
	submit: (result: SubagentResult) => boolean;
};

type Record = PublicSubagentRecord & {
	sessionId: string;
	task: string;
	startedAt: string;
	finishedAt?: string;
	controller: AbortController;
	taskRuntime?: TaskRuntime;
	waiters: Set<() => void>;
};

type Options = {
	store: SessionStore;
	context: ContextManager;
	resolveProfile: (
		sessionId: string,
		name: string,
	) => Promise<ResolvedAgentProfile> | ResolvedAgentProfile;
	execute: (request: SubagentExecutionRequest) => Promise<void>;
	steer: (agentId: string, message: string) => boolean;
	forget: (agentId: string) => void;
	emit?: (
		sessionId: string,
		record: PublicSubagentRecord & {
			startedAt?: string;
			finishedAt?: string;
		},
	) => void;
};

const restartResult: SubagentResult = {
	status: "failed",
	findings: [],
	decisions: [],
	changedFiles: [],
	verification: [],
	unresolvedIssues: [
		"The server restarted before the subagent completed. Start a new subagent to retry the work.",
	],
	artifactRefs: [],
};
const noHandoff: SubagentResult = {
	status: "failed",
	findings: [],
	decisions: [],
	changedFiles: [],
	verification: [],
	unresolvedIssues: [
		"The subagent ended without submitting a structured handoff.",
	],
	artifactRefs: [],
};
const terminal = (state: SubagentState) =>
	!["running", "cancelling"].includes(state);

export class SubagentManager {
	private readonly records = new Map<string, Record>();
	constructor(private readonly options: Options) {}

	async spawn(input: {
		sessionId: string;
		profile: string;
		task: string;
		description: string;
	}): Promise<{ id: string; state: "running" }> {
		const profile = await this.options.resolveProfile(
			input.sessionId,
			input.profile,
		);
		if (
			[...this.records.values()].filter((record) => !terminal(record.state))
				.length >= MAX_CONCURRENT_SUBAGENTS
		)
			throw new Error(
				`Maximum of ${MAX_CONCURRENT_SUBAGENTS} concurrent subagents reached`,
			);
		const main = this.options.store.lane(input.sessionId, "main");
		if (!main?.headItemId)
			throw new Error(
				"Cannot spawn a subagent before the main context is initialized",
			);
		const id = crypto.randomUUID();
		this.options.context.forkLane({
			sessionId: input.sessionId,
			name: id,
			ownerTaskId: id,
			fromItemId: main.headItemId,
		});
		this.options.context.record({
			sessionId: input.sessionId,
			originLane: id,
			kind: "pinned-note",
			lifecycle: "retained",
			projection: "omitted",
			reason: "subagent spawn metadata",
			payload: {
				schemaVersion: 1,
				id,
				profile: input.profile,
				description: input.description,
				task: input.task,
			},
			tokenCost: 0,
		});
		const record: Record = {
			id,
			sessionId: input.sessionId,
			profile: input.profile,
			description: input.description,
			task: input.task,
			state: "running",
			startedAt: new Date().toISOString(),
			controller: new AbortController(),
			waiters: new Set(),
		};
		this.records.set(id, record);
		this.publish(record);
		void this.execute(record, profile);
		return { id, state: "running" };
	}

	async get(
		sessionId: string,
		id: string,
		options: { wait?: boolean; signal?: AbortSignal } = {},
	): Promise<PublicSubagentRecord> {
		const record = this.require(sessionId, id);
		if (options.wait && !terminal(record.state))
			await this.wait(record, options.signal);
		return this.public(record);
	}

	steer(
		sessionId: string,
		id: string,
		message: string,
	): { id: string; state: string } {
		const record = this.require(sessionId, id);
		if (!terminal(record.state)) this.options.steer(id, message);
		return { id, state: record.state };
	}

	async cancel(
		sessionId: string,
		id: string,
	): Promise<{ id: string; state: "cancelling" | "cancelled" }> {
		const record = this.require(sessionId, id);
		if (terminal(record.state)) return { id, state: "cancelled" };
		if (record.state === "running") {
			record.state = "cancelling";
			this.publish(record);
			record.controller.abort();
			await record.taskRuntime?.cancel("cancelled");
		}
		return {
			id,
			state: record.state === "cancelling" ? "cancelling" : "cancelled",
		};
	}

	snapshot(sessionId: string): PublicSubagentRecord[] {
		return [...this.records.values()]
			.filter((record) => record.sessionId === sessionId)
			.map((record) => this.public(record));
	}

	recover(): number {
		let count = 0;
		for (const metadata of this.options.store.subagentMetadata()) {
			const lane = this.options.store.lane(metadata.sessionId, metadata.laneId);
			if (lane?.state !== "active") continue;
			this.options.context.finishTask({
				sessionId: metadata.sessionId,
				taskId: metadata.taskId,
				laneId: metadata.laneId,
				status: "failed",
				handoff: restartResult,
			});
			count++;
		}
		return count;
	}

	private async execute(
		record: Record,
		profile: ResolvedAgentProfile,
	): Promise<void> {
		try {
			await this.options.execute({
				sessionId: record.sessionId,
				agentId: record.id,
				laneId: record.id,
				task: record.task,
				profile,
				signal: record.controller.signal,
				onRuntime: (task) => {
					record.taskRuntime = task;
				},
				submit: (result) => this.submit(record, result),
			});
			if (!terminal(record.state))
				this.finish(
					record,
					record.state === "cancelling" ? "cancelled" : "failed",
					noHandoff,
				);
		} catch {
			if (!terminal(record.state))
				this.finish(
					record,
					record.state === "cancelling" ? "cancelled" : "failed",
					noHandoff,
				);
		}
	}

	private submit(record: Record, result: SubagentResult): boolean {
		if (terminal(record.state) || record.state === "cancelling") return false;
		this.finish(record, result.status, result);
		return true;
	}
	private finish(
		record: Record,
		state: Exclude<SubagentState, "running" | "cancelling">,
		result: SubagentResult,
	): void {
		if (terminal(record.state)) return;
		record.state = state;
		record.result = result;
		record.finishedAt = new Date().toISOString();
		this.options.context.finishTask({
			sessionId: record.sessionId,
			taskId: record.id,
			laneId: record.id,
			status:
				state === "cancelled"
					? "cancelled"
					: state === "completed"
						? "completed"
						: "failed",
			startedAt: record.startedAt,
			handoff: result,
		});
		this.options.forget(record.id);
		this.publish(record);
		for (const resolve of record.waiters) resolve();
		record.waiters.clear();
	}
	private require(sessionId: string, id: string): Record {
		const existing = this.records.get(id);
		if (existing) {
			if (existing.sessionId !== sessionId) throw new Error("Unknown subagent");
			return existing;
		}
		const metadata = this.options.store
			.subagentMetadata(sessionId)
			.find((entry) => entry.payload.id === id);
		if (!metadata) throw new Error(`Unknown subagent ${id}`);
		const handoff = this.options.store.subagentHandoff(sessionId, id);
		const record: Record = {
			id,
			sessionId,
			profile: metadata.payload.profile,
			description: metadata.payload.description,
			task: metadata.payload.task,
			state: handoff?.status ?? "failed",
			...(handoff ? { result: handoff } : {}),
			startedAt: "",
			controller: new AbortController(),
			waiters: new Set(),
		};
		this.records.set(id, record);
		return record;
	}
	private wait(record: Record, signal?: AbortSignal): Promise<void> {
		return new Promise((resolve, reject) => {
			const done = () => {
				record.waiters.delete(done);
				signal?.removeEventListener("abort", abort);
				resolve();
			};
			const abort = () => {
				record.waiters.delete(done);
				reject(new DOMException("Aborted", "AbortError"));
			};
			record.waiters.add(done);
			signal?.addEventListener("abort", abort, { once: true });
		});
	}
	private public(record: Record): PublicSubagentRecord {
		return {
			id: record.id,
			profile: record.profile,
			description: record.description,
			state: record.state,
			...(record.result ? { result: record.result } : {}),
		};
	}
	private publish(record: Record): void {
		this.options.emit?.(record.sessionId, {
			...this.public(record),
			startedAt: record.startedAt,
			...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
		});
	}
}
