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
export type ContextNodeRole = "message" | "checkpoint";
export type ContextLaneState =
	| "idle"
	| "active"
	| "completed"
	| "failed"
	| "cancelled"
	| "abandoned";
export type ContextSource = {
	toolCallId?: string;
	toolName?: string;
	evictionPriority?: "early" | "normal" | "late";
	observationId?: string;
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
	action: "start" | "end";
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
	state: "active" | "completed" | "archived";
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
	) {
		super(
			`Context budget cannot be satisfied (${estimatedTokens} > ${budget})`,
		);
		this.name = "ContextBudgetError";
	}
}
