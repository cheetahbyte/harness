import type { CapabilitySnapshot } from "./capabilities/catalog";
import type { CapabilityContext } from "./capabilities/context";
import type {
	CapabilityGrant,
	CapabilityRef,
	EffectClass,
	InspectedCapability,
	ToolGrant,
} from "./capabilities/types";
import {
	buildTaskEvidence,
	buildTaskLedgerDigest,
	type CapabilityCallOutcome,
	type EvidenceDigest,
	type ExecutionLedgerEntry,
	type TaskLedgerDigest,
} from "./task-ledger";

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

type TaskFailure = { code: string; message: string };
export type TaskTerminalResult =
	| { status: "completed"; terminalMessageIds: MessageId[] }
	| {
			status: "failed";
			error: TaskFailure;
			terminalMessageIds: MessageId[];
	  }
	| { status: "cancelled"; terminalMessageIds: MessageId[] }
	| { status: "superseded"; terminalMessageIds: MessageId[] };
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
		return buildTaskLedgerDigest(
			{
				entries: this.events,
				terminal: this.terminal.status,
				startedAt: this.startedAt,
				finishedAt: this.finishedAt,
			},
			successor,
		);
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
		return buildTaskEvidence(value, this.evidenceKey);
	}

	private timestamp(): Timestamp {
		return this.now().toISOString();
	}
}

function toolEffect(inspected: InspectedCapability): EffectClass {
	if (inspected.kind !== "tool" || !("effect" in inspected.contract))
		throw new Error("CAPABILITY_NOT_EXECUTABLE");
	return inspected.contract.effect;
}

async function delay(milliseconds: number): Promise<void> {
	if (milliseconds <= 0) return;
	await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
