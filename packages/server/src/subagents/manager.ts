import type { ContextManager } from "../context/manager";
import type {
	PublicSubagentRecord,
	SubagentResult,
	SubagentState,
} from "../context/types";
import type { SessionStore } from "../sessions/store";
import type { TaskRuntime } from "../task-runtime";
import type { ResolvedAgentProfile } from "./profiles";

export type SubagentExecutionRequest = {
	sessionId: string;
	agentId: string;
	taskId: string;
	laneId: string;
	task: string;
	profile: ResolvedAgentProfile;
	signal: AbortSignal;
	onRuntime: (task: TaskRuntime) => void;
	submit: (result: SubagentResult) => boolean;
};

export type SubagentActor =
	| { kind: "operator"; sessionId: string }
	| { kind: "agent"; sessionId: string; agentId?: string };
export type SubagentCommand =
	| { action: "spawn"; profile: string; task: string; description: string }
	| { action: "get"; id: string; wait?: boolean; signal?: AbortSignal }
	| { action: "steer"; id: string; message: string }
	| { action: "cancel"; id: string }
	| { action: "resume"; id: string; message: string };

type Record = PublicSubagentRecord & {
	sessionId: string;
	task: string;
	runTaskId?: string;
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
	limits?: (sessionId: string) => { maxConcurrent: number; maxDepth: number };
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
	!["queued", "running", "cancelling"].includes(state);

export class SubagentManager {
	private readonly records = new Map<string, Record>();
	constructor(private readonly options: Options) {}

	async dispatch(actor: SubagentActor, command: SubagentCommand) {
		const sessionId = actor.sessionId;
		if (command.action === "spawn" && actor.kind === "agent")
			return this.spawn({
				sessionId,
				profile: command.profile,
				task: command.task,
				description: command.description,
				...(actor.agentId === undefined
					? {}
					: { parentAgentId: actor.agentId }),
			});
		if (command.action !== "spawn" && actor.kind === "agent") {
			const target = this.options.store.subagent(sessionId, command.id);
			if (!target || target.parentAgentId !== actor.agentId)
				throw new Error("Unknown subagent");
		}
		switch (command.action) {
			case "spawn":
				return this.spawn({ sessionId, ...command });
			case "get":
				return this.get(sessionId, command.id, command);
			case "steer":
				return this.steer(sessionId, command.id, command.message);
			case "cancel":
				return this.cancel(sessionId, command.id);
			case "resume":
				return this.resume(sessionId, command.id, command.message);
		}
	}

	async spawn(input: {
		sessionId: string;
		profile: string;
		task: string;
		description: string;
		parentAgentId?: string;
	}): Promise<{ id: string; state: "queued" | "running" }> {
		const profile = await this.options.resolveProfile(
			input.sessionId,
			input.profile,
		);
		const parent = input.parentAgentId
			? this.options.store.subagent(input.sessionId, input.parentAgentId)
			: undefined;
		if (input.parentAgentId && !parent)
			throw new Error("Unknown parent subagent");
		if (parent) {
			const parentProfile = await this.options.resolveProfile(
				input.sessionId,
				parent.profile,
			);
			if (
				parentProfile.allowedSubagents !== "all" &&
				!parentProfile.allowedSubagents.includes(input.profile)
			)
				throw new Error(
					`Profile ${parent.profile} cannot spawn ${input.profile}`,
				);
			if (
				parent.depth >= (this.options.limits?.(input.sessionId).maxDepth ?? 2)
			)
				throw new Error("Maximum subagent nesting depth reached");
		}
		if (!this.options.store.lane(input.sessionId, "main")?.headItemId)
			throw new Error(
				"Cannot spawn a subagent before the main context is initialized",
			);
		const id = crypto.randomUUID();
		const record: Record = {
			id,
			sessionId: input.sessionId,
			profile: input.profile,
			description: input.description,
			task: input.task,
			state: "queued",
			...(parent
				? { parentId: parent.id, depth: parent.depth + 1 }
				: { depth: 1 }),
			startedAt: "",
			controller: new AbortController(),
			waiters: new Set(),
		};
		this.records.set(id, record);
		this.options.store.createSubagent({
			id,
			sessionId: input.sessionId,
			profile: input.profile,
			description: input.description,
			...(parent
				? { parentAgentId: parent.id, depth: parent.depth + 1 }
				: { depth: 1 }),
			state: "queued",
			pendingMessage: input.task,
		});
		this.publish(record);
		void this.drain(input.sessionId, profile);
		return { id, state: "queued" };
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
		if (record.state === "queued") {
			record.state = "cancelled";
			record.finishedAt = new Date().toISOString();
			this.options.store.updateSubagent(sessionId, id, {
				state: "cancelled",
				finishedAt: record.finishedAt,
			});
			this.publish(record);
			return { id, state: "cancelled" };
		}
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

	async resume(
		sessionId: string,
		id: string,
		message: string,
	): Promise<{ id: string; state: "running" }> {
		const record = this.require(sessionId, id);
		if (!terminal(record.state) || record.state === "queued")
			throw new Error("Only terminal subagents can be resumed");
		const profile = await this.options.resolveProfile(
			sessionId,
			record.profile,
		);
		const taskId = crypto.randomUUID();
		const durable = this.options.store.startSubagentRun(sessionId, id, taskId);
		if (!durable) throw new Error("Subagent is already active");
		if (!durable.laneId)
			throw new Error("Subagent has no resumable context lane");
		this.options.store.reactivateChildLane(sessionId, durable.laneId, taskId);
		record.task = message;
		record.runTaskId = taskId;
		record.startedAt = durable.startedAt ?? new Date().toISOString();
		delete record.finishedAt;
		delete record.result;
		record.state = "running";
		this.publish(record);
		void this.execute(record, profile);
		return { id, state: "running" };
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
				taskId: record.runTaskId ?? record.id,
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
					this.noHandoff(record),
				);
		} catch (error) {
			if (!terminal(record.state))
				this.finish(
					record,
					record.state === "cancelling" ? "cancelled" : "failed",
					failureResult(error),
				);
		}
	}

	private submit(record: Record, result: SubagentResult): boolean {
		if (terminal(record.state) || record.state === "cancelling") return false;
		this.finish(record, result.status, result);
		return true;
	}
	private noHandoff(record: Record): SubagentResult {
		const lastAssistant = this.options.store
			.contextPath(record.sessionId, record.id)
			.toReversed()
			.find((item) => item.kind === "assistant")?.payload as
			| { content?: readonly { type?: string; text?: string }[] }
			| undefined;
		const text = lastAssistant?.content
			?.filter((part) => part.type === "text")
			.map((part) => part.text ?? "")
			.join("");
		return text ? { ...noHandoff, findings: [text] } : noHandoff;
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
		this.options.store.updateSubagent(record.sessionId, record.id, {
			state,
			result,
			finishedAt: record.finishedAt,
		});
		this.options.context.finishTask({
			sessionId: record.sessionId,
			taskId: record.runTaskId ?? record.id,
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
		void this.drain(record.sessionId);
	}
	private require(sessionId: string, id: string): Record {
		const existing = this.records.get(id);
		if (existing) {
			if (existing.sessionId !== sessionId) throw new Error("Unknown subagent");
			return existing;
		}
		const durable = this.options.store.subagent(sessionId, id);
		if (durable) {
			const record: Record = {
				id: durable.id,
				sessionId: durable.sessionId,
				profile: durable.profile,
				description: durable.description,
				task: durable.pendingMessage ?? "",
				state: durable.state,
				...(durable.result ? { result: durable.result } : {}),
				startedAt: durable.startedAt ?? "",
				...(durable.finishedAt ? { finishedAt: durable.finishedAt } : {}),
				controller: new AbortController(),
				waiters: new Set(),
			};
			this.records.set(id, record);
			return record;
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

	private async drain(
		sessionId: string,
		initial?: ResolvedAgentProfile,
	): Promise<void> {
		const limit = this.options.limits?.(sessionId).maxConcurrent ?? 16;
		while (
			[...this.records.values()].filter(
				(record) =>
					record.sessionId === sessionId && record.state === "running",
			).length < limit
		) {
			const record = [...this.records.values()].find(
				(entry) => entry.sessionId === sessionId && entry.state === "queued",
			);
			if (!record) return;
			try {
				const profile =
					initial && initial.name === record.profile
						? initial
						: await this.options.resolveProfile(sessionId, record.profile);
				const prefix = this.options.store.contextPath(sessionId, "main")[0];
				if (!prefix)
					throw new Error("Cannot spawn without a system context prefix");
				record.startedAt = new Date().toISOString();
				record.runTaskId = crypto.randomUUID();
				this.options.context.forkLane({
					sessionId,
					name: record.id,
					ownerTaskId: record.runTaskId,
					fromItemId: prefix.id,
				});
				this.options.context.record({
					sessionId,
					originLane: record.id,
					kind: "pinned-note",
					lifecycle: "retained",
					projection: "omitted",
					reason: "subagent spawn metadata",
					payload: {
						schemaVersion: 1,
						id: record.id,
						profile: record.profile,
						description: record.description,
						task: record.task,
					},
					tokenCost: 0,
				});
				record.state = "running";
				this.options.store.updateSubagent(sessionId, record.id, {
					laneId: record.id,
					state: "running",
					activeTaskId: record.runTaskId,
					startedAt: record.startedAt,
				});
				this.publish(record);
				void this.execute(record, profile);
				initial = undefined;
			} catch {
				record.state = "failed";
				record.result = noHandoff;
				record.finishedAt = new Date().toISOString();
				this.options.store.updateSubagent(sessionId, record.id, {
					state: "failed",
					result: noHandoff,
					finishedAt: record.finishedAt,
				});
				this.publish(record);
			}
		}
	}
}

function failureResult(error: unknown): SubagentResult {
	return {
		...noHandoff,
		unresolvedIssues: [error instanceof Error ? error.message : String(error)],
	};
}
