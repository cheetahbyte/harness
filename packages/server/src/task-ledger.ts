import { createHmac } from "node:crypto";

import type { CapabilitySnapshot } from "./capabilities/catalog";
import { canonicalJson } from "./capabilities/hash";
import type {
	CapabilityGrant,
	CapabilityRef,
	EffectClass,
} from "./capabilities/types";
import type { CallId, TaskTerminalStatus, Timestamp } from "./task-runtime";

export type EvidenceDigest = {
	scheme: "jcs-hmac-sha256-v1";
	digest: string;
};
export type CapabilityCallOutcome =
	| "success"
	| "failure"
	| "cancelled_before_start"
	| "cancelled_acknowledged"
	| "outcome_unknown";
export type TaskRecoveryReason = "owned_lane_terminal";
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
	| {
			type: "source_range_read";
			sourceId: string;
			range: readonly [start: number, end: number];
			at: Timestamp;
	  }
	| { type: "cancellation_requested"; at: Timestamp }
	| {
			type: "task_recovery";
			reason: TaskRecoveryReason;
			at: Timestamp;
	  };

type SafeCapabilitySummary = {
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
export type TaskLedger = {
	entries: readonly ExecutionLedgerEntry[];
	terminal: TaskTerminalStatus;
	startedAt: Timestamp;
	finishedAt: Timestamp;
};

export function buildTaskEvidence(
	value: unknown,
	key: Uint8Array,
): EvidenceDigest {
	return {
		scheme: "jcs-hmac-sha256-v1",
		digest: createHmac("sha256", key)
			.update(canonicalJson(redact(value)))
			.digest("hex"),
	};
}

export function buildTaskLedgerDigest(
	ledger: TaskLedger,
	successor: CapabilitySnapshot,
): TaskLedgerDigest {
	const starts = ledger.entries.filter(
		(
			event,
		): event is Extract<
			ExecutionLedgerEntry,
			{ type: "capability_call_started" }
		> => event.type === "capability_call_started",
	);
	const finishes = new Map(
		ledger.entries.flatMap((event) =>
			event.type === "capability_call_finished"
				? [[event.callId, event] as const]
				: [],
		),
	);
	const discoverable = discoverableById(successor);
	const referenced = new Map<string, SafeCapabilitySummary>();
	for (const start of starts) {
		const safe = discoverable.get(start.capability.id);
		if (!safe) continue;
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
	return {
		status: ledger.terminal,
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
		referencedCapabilities: [...referenced.values()].toSorted((a, b) =>
			a.id.localeCompare(b.id),
		),
		startedAt: ledger.startedAt,
		finishedAt: ledger.finishedAt,
	};
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
