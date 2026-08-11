import { createHmac } from "node:crypto";
import {
	type CapabilityContext,
	type CapabilityGrant,
	type CapabilityRef,
	type CapabilitySnapshot,
	canonicalJson,
	type EffectClass,
	type InspectedCapability,
	type ToolGrant,
} from "./capability-control";

export type TaskId = string;
export type CallId = string;
export type MessageId = string;
export type ConversationRevision = number;
export type Timestamp = string;
export type TaskTerminalStatus =
	| "completed"
	| "failed"
	| "cancelled"
	| "superseded";
export type TaskState = "running" | "cancelling" | "quiescing" | "terminal";
export type CapabilityCallOutcome =
	| "success"
	| "failure"
	| "cancelled_before_start"
	| "cancelled_acknowledged"
	| "outcome_unknown";
export type EvidenceDigest = {
	scheme: "jcs-hmac-sha256-v1";
	digest: string;
};
export type ExecutionLedgerEntry =
	| {
			type: "capability_call_started";
			callId: CallId;
			capability: CapabilityRef;
			effect: EffectClass;
			startedAt: Timestamp;
			inputEvidence?: EvidenceDigest;
	  }
	| {
			type: "capability_call_finished";
			callId: CallId;
			outcome: CapabilityCallOutcome;
			finishedAt: Timestamp;
			outputEvidence?: EvidenceDigest;
	  }
	| {
			type: "grant_reduced";
			capabilityId: string;
			before: CapabilityGrant;
			after: CapabilityGrant;
			at: Timestamp;
	  }
	| { type: "cancellation_requested"; at: Timestamp };

export type TaskFailure = { code: string; message: string };
export type TaskTerminalResult =
	| { status: "completed"; terminalMessageIds: MessageId[] }
	| {
			status: "failed";
			error: TaskFailure;
			terminalMessageIds: MessageId[];
	  }
	| { status: "cancelled"; terminalMessageIds: MessageId[] }
	| { status: "superseded"; terminalMessageIds: MessageId[] };
export type SafeCapabilitySummary = {
	id: string;
	kind: "tool" | "skill";
	name: string;
	effect?: EffectClass;
};
export type TaskLedgerDigest = {
	status: TaskTerminalStatus;
	capabilityCalls: number;
	failedCalls: number;
	successfulMutatingCalls: number;
	unknownMutatingCalls: number;
	cancelledCalls: number;
	referencedCapabilities: SafeCapabilitySummary[];
	startedAt: Timestamp;
	finishedAt: Timestamp;
};
export type CapabilityExecutor = {
	execute(input: unknown, signal: AbortSignal): Promise<unknown>;
	cancel?(
		callId: CallId,
	): Promise<"cancelled_acknowledged" | "outcome_unknown">;
};
export type ExecuteOptions = { confirmationId?: string };
export type TokenReconciliation = {
	modelId: string;
	estimatedInputTokens: number;
	providerInputTokens: number;
	absoluteDivergence: number;
	percentageDivergence: number;
};

type InFlight = {
	callId: CallId;
	ref: CapabilityRef;
	effect: EffectClass;
	controller: AbortController;
	executor: CapabilityExecutor;
	finished: boolean;
	settled: Promise<void>;
	settle: () => void;
};

export class ConfirmationRequiredError extends Error {
	constructor(
		readonly callId: string,
		readonly capabilityId: string,
	) {
		super(`CONFIRMATION_REQUIRED:${callId}`);
		this.name = "ConfirmationRequiredError";
	}
}

export class TaskRuntime {
	readonly id: TaskId;
	readonly startedAt: Timestamp;
	state: TaskState = "running";
	private readonly events: ExecutionLedgerEntry[] = [];
	private readonly inFlight = new Map<CallId, InFlight>();
	private readonly pendingConfirmations = new Map<string, string>();
	private readonly confirmedCalls = new Map<string, string>();
	private readonly confirmedCapabilities = new Set<string>();
	private readonly loadedCapabilities = new Map<string, CapabilityRef>();
	private readonly steers: string[] = [];
	private readonly reconciliations: TokenReconciliation[] = [];
	private cancellation: Promise<TaskTerminalResult> | undefined;
	private terminal?: TaskTerminalResult;
	private finishedAt?: Timestamp;
	private unknownPriorEffectsAcknowledged: boolean;
	readonly predecessorDigest: TaskLedgerDigest | undefined;
	readonly submissionWatermark: number | undefined;
	readonly taskStartSequence: number | undefined;
	readonly predecessorTerminalMessageIds: readonly string[];

	constructor(
		readonly snapshot: CapabilitySnapshot,
		readonly context: CapabilityContext,
		private readonly evidenceKey: Uint8Array,
		options: {
			id?: string;
			startedAt?: Timestamp;
			cancellationGraceMs?: number;
			unknownPriorMutatingEffects?: boolean;
			predecessorDigest?: TaskLedgerDigest;
			submissionWatermark?: number;
			taskStartSequence?: number;
			predecessorTerminalMessageIds?: readonly string[];
			now?: () => Date;
		} = {},
	) {
		this.id = options.id ?? crypto.randomUUID();
		this.now = options.now ?? (() => new Date());
		this.startedAt = options.startedAt ?? this.timestamp();
		this.cancellationGraceMs = options.cancellationGraceMs ?? 1_000;
		this.unknownPriorEffectsAcknowledged = !options.unknownPriorMutatingEffects;
		this.predecessorDigest = options.predecessorDigest
			? structuredClone(options.predecessorDigest)
			: undefined;
		this.submissionWatermark = options.submissionWatermark;
		this.taskStartSequence = options.taskStartSequence;
		this.predecessorTerminalMessageIds = [
			...(options.predecessorTerminalMessageIds ?? []),
		];
	}

	private readonly now: () => Date;
	private readonly cancellationGraceMs: number;

	async execute(
		ref: CapabilityRef,
		input: unknown,
		executor: CapabilityExecutor,
		options: ExecuteOptions = {},
	): Promise<unknown> {
		if (this.state !== "running") throw new Error("TASK_NOT_RUNNING");
		const inspected = this.snapshot.verifyCurrent(ref);
		const loaded = this.loadedCapabilities.get(ref.id);
		if (!loaded || loaded.contractHash !== ref.contractHash)
			throw new Error("CAPABILITY_NOT_LOADED");
		const effect = toolEffect(inspected);
		if (effect === "mutating" && !this.unknownPriorEffectsAcknowledged)
			throw new Error("UNKNOWN_PRIOR_EFFECT_ACKNOWLEDGEMENT_REQUIRED");
		const grant = this.snapshot.grant(ref.id);
		if (grant.kind !== "tool" || grant.maxLevel !== "execute")
			throw new Error("AUTHORIZATION_DENIED");
		this.requireConfirmation(ref.id, grant, options.confirmationId);
		const callId = crypto.randomUUID();
		let settle!: () => void;
		const settled = new Promise<void>((resolve) => (settle = resolve));
		const call: InFlight = {
			callId,
			ref: structuredClone(ref),
			effect,
			controller: new AbortController(),
			executor,
			finished: false,
			settled,
			settle,
		};
		this.inFlight.set(callId, call);
		this.events.push({
			type: "capability_call_started",
			callId,
			capability: structuredClone(ref),
			effect,
			startedAt: this.timestamp(),
			inputEvidence: this.evidence(input),
		});
		try {
			const output = await executor.execute(input, call.controller.signal);
			this.finishCall(call, "success", output);
			return output;
		} catch (error) {
			if (!call.finished)
				this.finishCall(
					call,
					this.state === "running" ? "failure" : "outcome_unknown",
				);
			throw error;
		}
	}

	confirm(callId: string): void {
		const capabilityId = this.pendingConfirmations.get(callId);
		if (!capabilityId) throw new Error("unknown confirmation request");
		this.pendingConfirmations.delete(callId);
		this.confirmedCalls.set(callId, capabilityId);
	}

	load(ref: CapabilityRef): void {
		if (this.state !== "running") throw new Error("TASK_NOT_RUNNING");
		this.snapshot.require(ref, "load");
		this.snapshot.verifyCurrent(ref);
		this.loadedCapabilities.set(ref.id, structuredClone(ref));
	}

	reduceGrant(capabilityId: string, after: CapabilityGrant): void {
		const before = this.snapshot.reduceGrant(capabilityId, after);
		this.events.push({
			type: "grant_reduced",
			capabilityId,
			before,
			after: { ...after },
			at: this.timestamp(),
		});
	}

	steer(message: string): void {
		if (this.state !== "running") throw new Error("TASK_NOT_RUNNING");
		this.steers.push(message);
	}

	steeringMessages(): readonly string[] {
		return [...this.steers];
	}

	reconcileProviderUsage(providerInputTokens: number): void {
		if (!Number.isSafeInteger(providerInputTokens) || providerInputTokens < 0)
			return;
		const accounting = this.context.lastAccounting();
		if (!accounting) return;
		const absoluteDivergence = Math.abs(
			providerInputTokens - accounting.estimatedInputTokens,
		);
		this.reconciliations.push({
			modelId: accounting.modelId,
			estimatedInputTokens: accounting.estimatedInputTokens,
			providerInputTokens,
			absoluteDivergence,
			percentageDivergence:
				accounting.estimatedInputTokens === 0
					? providerInputTokens === 0
						? 0
						: 100
					: (absoluteDivergence / accounting.estimatedInputTokens) * 100,
		});
	}

	tokenReconciliations(): TokenReconciliation[] {
		return structuredClone(this.reconciliations);
	}

	acknowledgeUnknownPriorEffects(): void {
		this.unknownPriorEffectsAcknowledged = true;
	}

	holdMutationsForUnknownPriorEffects(): void {
		this.unknownPriorEffectsAcknowledged = false;
	}

	cancel(
		status: "cancelled" | "superseded" = "cancelled",
		terminalMessageIds: MessageId[] = [],
	): Promise<TaskTerminalResult> {
		if (this.terminal) return Promise.resolve(structuredClone(this.terminal));
		if (this.cancellation) return this.cancellation;
		if (this.state !== "running") throw new Error("TASK_ALREADY_CANCELLING");
		this.cancellation = this.cancelRunning(status, terminalMessageIds);
		return this.cancellation;
	}

	private async cancelRunning(
		status: "cancelled" | "superseded",
		terminalMessageIds: MessageId[],
	): Promise<TaskTerminalResult> {
		this.state = "cancelling";
		this.events.push({ type: "cancellation_requested", at: this.timestamp() });
		const cancellations = [...this.inFlight.values()].map(async (call) => {
			call.controller.abort();
			if (!call.executor.cancel) return;
			try {
				const outcome = await call.executor.cancel(call.callId);
				this.finishCall(call, outcome);
			} catch {
				this.finishCall(call, "outcome_unknown");
			}
		});
		await Promise.allSettled(cancellations);
		this.state = "quiescing";
		const calls = [...this.inFlight.values()];
		if (calls.length)
			await Promise.race([
				Promise.all(calls.map((call) => call.settled)),
				delay(this.cancellationGraceMs),
			]);
		for (const call of calls) this.finishCall(call, "outcome_unknown");
		return this.finish({ status, terminalMessageIds: [...terminalMessageIds] });
	}

	finish(result: TaskTerminalResult): TaskTerminalResult {
		if (this.terminal) return structuredClone(this.terminal);
		if (this.inFlight.size) throw new Error("TASK_NOT_QUIESCENT");
		this.state = "terminal";
		this.terminal = structuredClone(result);
		this.finishedAt = this.timestamp();
		this.context.destroy();
		return structuredClone(result);
	}

	result(): TaskTerminalResult | undefined {
		return this.terminal ? structuredClone(this.terminal) : undefined;
	}

	addTerminalMessageIds(messageIds: MessageId[]): void {
		if (!this.terminal) throw new Error("TASK_NOT_TERMINAL");
		this.terminal.terminalMessageIds = [
			...new Set([...this.terminal.terminalMessageIds, ...messageIds]),
		];
	}

	ledger(): ExecutionLedgerEntry[] {
		return structuredClone(this.events);
	}

	digest(successor: CapabilitySnapshot): TaskLedgerDigest {
		if (!this.terminal || !this.finishedAt)
			throw new Error("TASK_NOT_TERMINAL");
		const starts = this.events.filter(
			(
				event,
			): event is Extract<
				ExecutionLedgerEntry,
				{ type: "capability_call_started" }
			> => event.type === "capability_call_started",
		);
		const finishes = new Map(
			this.events.flatMap((event) =>
				event.type === "capability_call_finished"
					? [[event.callId, event] as const]
					: [],
			),
		);
		const discoverable = discoverableById(successor);
		const referenced = new Map<string, SafeCapabilitySummary>();
		for (const start of starts) {
			const safe = discoverable.get(start.capability.id);
			if (safe) {
				let effect: EffectClass | undefined;
				try {
					const inspected = successor.inspect(safe.ref);
					if (inspected.kind === "tool" && "effect" in inspected.contract)
						effect = inspected.contract.effect;
				} catch {}
				referenced.set(start.capability.id, {
					id: safe.ref.id,
					kind: safe.kind,
					name: safe.name,
					...(effect ? { effect } : {}),
				});
			}
		}
		return {
			status: this.terminal.status,
			capabilityCalls: starts.length,
			failedCalls: starts.filter(
				(start) => finishes.get(start.callId)?.outcome === "failure",
			).length,
			successfulMutatingCalls: starts.filter(
				(start) =>
					start.effect === "mutating" &&
					finishes.get(start.callId)?.outcome === "success",
			).length,
			unknownMutatingCalls: starts.filter(
				(start) =>
					start.effect === "mutating" &&
					finishes.get(start.callId)?.outcome === "outcome_unknown",
			).length,
			cancelledCalls: starts.filter((start) =>
				["cancelled_before_start", "cancelled_acknowledged"].includes(
					finishes.get(start.callId)?.outcome ?? "",
				),
			).length,
			referencedCapabilities: [...referenced.values()].sort((a, b) =>
				a.id.localeCompare(b.id),
			),
			startedAt: this.startedAt,
			finishedAt: this.finishedAt,
		};
	}

	private requireConfirmation(
		capabilityId: string,
		grant: ToolGrant,
		confirmationId?: string,
	): void {
		if (grant.confirmation === "none") return;
		if (
			grant.confirmation === "confirm_once" &&
			this.confirmedCapabilities.has(capabilityId)
		)
			return;
		if (
			confirmationId &&
			this.confirmedCalls.get(confirmationId) === capabilityId
		) {
			this.confirmedCalls.delete(confirmationId);
			if (grant.confirmation === "confirm_once")
				this.confirmedCapabilities.add(capabilityId);
			return;
		}
		const callId = crypto.randomUUID();
		this.pendingConfirmations.set(callId, capabilityId);
		throw new ConfirmationRequiredError(callId, capabilityId);
	}

	private finishCall(
		call: InFlight,
		outcome: CapabilityCallOutcome,
		output?: unknown,
	): void {
		if (call.finished) return;
		call.finished = true;
		this.events.push({
			type: "capability_call_finished",
			callId: call.callId,
			outcome,
			finishedAt: this.timestamp(),
			...(output === undefined
				? {}
				: { outputEvidence: this.evidence(output) }),
		});
		this.inFlight.delete(call.callId);
		call.settle();
	}

	private evidence(value: unknown): EvidenceDigest {
		return {
			scheme: "jcs-hmac-sha256-v1",
			digest: createHmac("sha256", this.evidenceKey)
				.update(canonicalJson(redact(value)))
				.digest("hex"),
		};
	}

	private timestamp(): Timestamp {
		return this.now().toISOString();
	}
}

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

	active(): TaskRuntime | undefined {
		return this.current;
	}

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
			"follow-up",
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
			"follow-up",
		);
		this.pending[index] = queued;
		return {
			cancelled: structuredClone(cancelled),
			queued: structuredClone(queued),
		};
	}

	queue(): QueuedTask[] {
		return structuredClone([
			...(this.replacement ? [this.replacement] : []),
			...this.pending,
		]);
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

function toolEffect(inspected: InspectedCapability): EffectClass {
	if (inspected.kind !== "tool" || !("effect" in inspected.contract))
		throw new Error("CAPABILITY_NOT_EXECUTABLE");
	return inspected.contract.effect;
}

function discoverableById(snapshot: CapabilitySnapshot) {
	const found = new Map<
		string,
		ReturnType<CapabilitySnapshot["list"]>["items"][number]
	>();
	let cursor: string | undefined;
	do {
		const page = snapshot.list({ limit: 100, ...(cursor ? { cursor } : {}) });
		for (const item of page.items) found.set(item.ref.id, item);
		cursor = page.nextCursor;
	} while (cursor);
	return found;
}

function redact(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(redact);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			/(secret|token|password|credential|api.?key)/i.test(key)
				? "[REDACTED]"
				: redact(item),
		]),
	);
}

async function delay(milliseconds: number): Promise<void> {
	if (milliseconds <= 0) return;
	await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
