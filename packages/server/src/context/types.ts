export type ContextLifecycle = "pinned" | "active" | "retained" | "archived";
export type ContextProjection = "full" | "compact" | "reference" | "omitted";
export type ContextKind =
	| "system"
	| "user"
	| "assistant"
	| "tool-result"
	| "observation"
	| "pinned-note"
	| "subagent-handoff"
	| "long-term-memory";
type ContextNodeRole = "message" | "checkpoint";
export type ContextLaneState =
	| "idle"
	| "active"
	| "completed"
	| "failed"
	| "cancelled"
	| "abandoned";
export type SourceRange = readonly [start: number, end: number];
export type ContextSource = {
	toolCallId?: string;
	toolName?: string;
	evictionPriority?: "early" | "normal" | "late";
	observationId?: string;
	totalCharacters?: number;
	previewedRanges?: SourceRange[];
	subagentId?: string;
	isError?: boolean;
};
export type ContextItem = {
	id: string;
	sessionId: string;
	sequence: number;
	parentId?: string;
	originLane: string;
	nodeRole: ContextNodeRole;
	contentHash: string;
	sourceDigest?: string;
	policyVersion?: number;
	kind: ContextKind;
	payload: unknown;
	compactPayload?: unknown;
	tokenCost: number;
	compactTokenCost?: number;
	source?: ContextSource;
	groupId?: string;
	episodeId?: string;
	lifecycle: ContextLifecycle;
	projection: ContextProjection;
	reason: string;
	createdAt: string;
	updatedAt: string;
};
export type CheckpointRepresentation =
	| { kind: "condensation"; memory: unknown }
	| { kind: "fallback"; summary: string; references: string[] };
export type ContextCheckpointPayload = {
	schemaVersion: 1;
	coveredThroughId?: string;
	baseCheckpointId?: string;
	baseRevision: number;
	omittedDigest: string;
	coverage: {
		sourceCount: number;
		condensedCount: number;
		retainedCount: number;
		omittedCount: number;
		omittedDigest: string;
		references: string[];
	};
	sourceDigest: string;
	policyVersion: number;
	representation: CheckpointRepresentation;
	/** The exact provider-visible tail retained after the covered prefix. */
	retainedTail: unknown[];
};
export type PreparedTurn = {
	messages: unknown[];
	estimatedTokens: number;
	checkpointId?: string;
	usedFallback: boolean;
};
export type NewContextItem = Omit<
	ContextItem,
	"sequence" | "updatedAt" | "originLane" | "nodeRole" | "contentHash"
> & {
	originLane?: string;
	nodeRole?: ContextNodeRole;
	contentHash?: string;
};
export type ContextLane = {
	sessionId: string;
	name: string;
	headItemId?: string;
	forkedFromItemId?: string;
	ownerTaskId?: string;
	state: ContextLaneState;
	revision: number;
	createdAt: string;
	closedAt?: string;
};
export type NewEpisodeEvent = {
	id: string;
	sessionId: string;
	episodeId: string;
	action: "start" | "end" | "failed" | "cancelled" | "abandoned";
	name: string;
	kind: "exploration" | "action";
	dependencies: string[];
	conclusion?: string;
	createdAt: string;
};
export type ContextEpisodeEvent = NewEpisodeEvent & { sequence: number };
export type ContextEpisode = {
	id: string;
	sessionId: string;
	name: string;
	kind: "exploration" | "action";
	dependencies: string[];
	conclusion?: string;
	state:
		| "active"
		| "completed"
		| "failed"
		| "cancelled"
		| "abandoned"
		| "archived";
};
export type FinishContextTaskRequest = {
	sessionId: string;
	taskId: string;
	status: "completed" | "failed" | "cancelled" | "superseded";
	startedAt?: string;
	laneId?: string;
	episodeId?: string;
	ledger?: readonly import("../task-ledger").ExecutionLedgerEntry[];
	handoff?: SubagentResult;
};
export type ObservationRecallInput = {
	observationId: string;
	offset?: number;
	limit?: number;
};
export type ObservationRecall = {
	observationId: string;
	text: string;
	offset: number;
	limit: number;
	totalLength: number;
	source: ContextSource;
};
export type PinOptions = {
	budget: number;
	target?: number;
	overheadTokens?: number;
};
export type PinKind = "decision" | "constraint";
export type InspectOptions = {
	budget?: number;
	target?: number;
	overheadTokens?: number;
};
export type SubagentResult = {
	status: "completed" | "blocked" | "failed";
	findings: string[];
	decisions: string[];
	changedFiles: string[];
	verification: string[];
	unresolvedIssues: string[];
	artifactRefs: string[];
};
export type SubagentState =
	| "running"
	| "cancelling"
	| "completed"
	| "blocked"
	| "failed"
	| "cancelled";
export type PublicSubagentRecord = {
	id: string;
	profile: string;
	description: string;
	state: SubagentState;
	result?: SubagentResult;
};
export type ContextInspection = {
	sessionId: string;
	estimatedTokens: number;
	/** Raw token cost of every recorded item, including archived and observations. */
	historyTokens: number;
	/** Externalized observations retrievable via `recall_observation`. */
	parkedObservations: number;
	budget?: number;
	target?: number;
	overheadTokens: number;
	counts: Record<ContextLifecycle, number>;
	episodes: ContextEpisode[];
	items: Array<
		Pick<
			ContextItem,
			| "id"
			| "sequence"
			| "kind"
			| "tokenCost"
			| "compactTokenCost"
			| "source"
			| "groupId"
			| "episodeId"
			| "lifecycle"
			| "projection"
			| "reason"
			| "createdAt"
			| "updatedAt"
		>
	>;
};
export type RecordInput = Omit<
	NewContextItem,
	"id" | "createdAt" | "projection"
> & {
	id?: string;
	createdAt?: string;
	projection?: ContextProjection;
};

export class ContextBudgetError extends Error {
	constructor(
		readonly estimatedTokens: number,
		readonly budget: number,
		readonly code: "CONTEXT_BUDGET" | "INPUT_TOO_LARGE" = "CONTEXT_BUDGET",
	) {
		super(
			`Context budget cannot be satisfied (${estimatedTokens} > ${budget})`,
		);
		this.name = "ContextBudgetError";
	}
}
