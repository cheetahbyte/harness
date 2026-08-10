import type { SessionStore } from "./session-store";

export type ContextLifecycle = "pinned" | "active" | "retained" | "archived";
export type ContextProjection = "full" | "compact" | "reference" | "omitted";
export type ContextKind =
	| "system"
	| "user"
	| "assistant"
	| "tool-result"
	| "observation"
	| "pinned-note"
	| "subagent-handoff";
export type ContextSource = {
	toolCallId?: string;
	toolName?: string;
	observationId?: string;
	subagentId?: string;
	isError?: boolean;
};
export type ContextItem = {
	id: string;
	sessionId: string;
	sequence: number;
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
export type NewContextItem = Omit<ContextItem, "sequence" | "updatedAt">;
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

export const DEFAULT_OBSERVATION_RECALL_LIMIT = 16 * 1024;
export const MAX_OBSERVATION_RECALL_LIMIT = 64 * 1024;

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

export type SubagentResult = {
	status: "completed" | "blocked" | "failed";
	findings: string[];
	decisions: string[];
	changedFiles: string[];
	verification: string[];
	unresolvedIssues: string[];
	artifactRefs: string[];
};

type RecordInput = Omit<NewContextItem, "id" | "createdAt" | "projection"> & {
	id?: string;
	createdAt?: string;
	projection?: ContextProjection;
};

const kinds = new Set<ContextKind>([
	"system",
	"user",
	"assistant",
	"tool-result",
	"observation",
	"pinned-note",
	"subagent-handoff",
]);
const lifecycles = new Set<ContextLifecycle>([
	"pinned",
	"active",
	"retained",
	"archived",
]);

export class ContextManager {
	constructor(private readonly store: SessionStore) {}

	record(input: RecordInput): ContextItem {
		const knownKind = kinds.has(input.kind);
		const createdAt = input.createdAt ?? new Date().toISOString();
		return this.store.appendContextItem({
			...input,
			id: input.id ?? crypto.randomUUID(),
			kind: knownKind ? input.kind : "pinned-note",
			lifecycle:
				knownKind && lifecycles.has(input.lifecycle)
					? input.lifecycle
					: "pinned",
			projection: input.projection ?? "full",
			createdAt,
		});
	}

	archive(id: string, reason: string): void {
		const item = this.store.contextItem(id);
		if (item?.kind !== "tool-result" || item.lifecycle !== "retained")
			throw new Error("Only retained tool results can be archived");
		this.store.setContextLifecycle(
			id,
			"archived",
			item.compactPayload === undefined ? "reference" : "compact",
			reason,
		);
	}

	completeTurn(sessionId: string, newToolResultIds: string[] = []): void {
		const newToolCallIds = new Set(newToolResultIds);
		for (const item of this.store.contextItems(sessionId))
			if (
				item.kind === "tool-result" &&
				item.lifecycle === "active" &&
				!newToolCallIds.has(item.source?.toolCallId ?? "")
			)
				this.store.setContextLifecycle(
					item.id,
					"retained",
					item.projection,
					"consumed by a later model turn",
				);
	}

	recordObservation(
		sessionId: string,
		exactOutput: string,
		source: ContextSource = {},
	): ContextItem {
		const observationId = source.observationId ?? `obs-${crypto.randomUUID()}`;
		return this.record({
			id: observationId,
			sessionId,
			kind: "observation",
			payload: exactOutput,
			tokenCost: characterCost(exactOutput),
			lifecycle: "archived",
			projection: "omitted",
			reason: "externalized observation",
			source: { ...source, observationId },
		});
	}

	recall(
		sessionId: string,
		reference: string | ObservationRecallInput,
	): ObservationRecall {
		const {
			observationId,
			offset = 0,
			limit = DEFAULT_OBSERVATION_RECALL_LIMIT,
		} = typeof reference === "string"
			? parseObservationUri(reference)
			: reference;
		validateRecallBounds(offset, limit);
		const item = this.store.contextItem(observationId);
		if (
			!item ||
			item.sessionId !== sessionId ||
			item.kind !== "observation" ||
			item.source?.observationId !== observationId ||
			typeof item.payload !== "string"
		)
			throw new Error("Observation not found");
		return {
			observationId,
			text: item.payload.slice(offset, offset + limit),
			offset,
			limit,
			totalLength: item.payload.length,
			source: item.source,
		};
	}

	pin(sessionId: string, text: string, options: PinOptions): ContextItem {
		if (!text.trim()) throw new Error("Pinned note cannot be empty");
		const payload = { role: "user", content: text };
		const note: ContextItem = {
			id: "",
			sessionId,
			sequence: 0,
			kind: "pinned-note",
			payload,
			tokenCost: characterCost(text),
			lifecycle: "pinned",
			projection: "full",
			reason: "pinned note",
			createdAt: "",
			updatedAt: "",
		};
		const estimatedTokens = projectedBudget(
			[...this.store.contextItems(sessionId), note],
			options,
		);
		if (estimatedTokens > options.budget)
			throw new ContextBudgetError(estimatedTokens, options.budget);
		const item = this.record({
			sessionId,
			kind: "pinned-note",
			payload,
			tokenCost: note.tokenCost,
			lifecycle: "pinned",
			reason: "pinned note",
		});
		this.assemble(sessionId, {
			budget: options.budget,
			target: options.target ?? options.budget,
			overheadTokens: options.overheadTokens ?? 0,
		});
		return item;
	}

	assemble(
		sessionId: string,
		options: { budget: number; target: number; overheadTokens: number },
	): { payloads: unknown[]; estimatedTokens: number; evictedIds: string[] } {
		let items = this.store.contextItems(sessionId);
		let estimatedTokens = estimatedCost(items, options.overheadTokens);
		const evictedIds: string[] = [];

		if (estimatedTokens > options.budget)
			for (const item of evictionCandidates(items)) {
				const archivedProjection =
					item.compactPayload === undefined ? "reference" : "compact";
				if (projectionCost(item, archivedProjection) >= projectionCost(item))
					continue;
				this.archive(item.id, "working-context budget");
				evictedIds.push(item.id);
				items = items.map((current) =>
					current.id === item.id
						? {
								...current,
								lifecycle: "archived",
								projection: archivedProjection,
								reason: "working-context budget",
							}
						: current,
				);
				estimatedTokens = estimatedCost(items, options.overheadTokens);
				if (estimatedTokens <= options.target) break;
			}

		if (estimatedTokens > options.budget)
			throw new ContextBudgetError(estimatedTokens, options.budget);

		return {
			payloads: items.flatMap((item) => {
				if (item.kind === "system" || item.kind === "observation") return [];
				const payload = projectedPayload(item);
				return payload === undefined ? [] : [payload];
			}),
			estimatedTokens,
			evictedIds,
		};
	}

	recordSubagentResult(
		sessionId: string,
		result: SubagentResult,
		source: Pick<ContextSource, "subagentId"> = {},
	): ContextItem {
		return this.record({
			sessionId,
			kind: "subagent-handoff",
			payload: result,
			tokenCost: Math.ceil(JSON.stringify(result).length / 4),
			lifecycle: "retained",
			reason: "structured subagent handoff",
			source,
		});
	}
}

function estimatedCost(items: ContextItem[], overheadTokens: number): number {
	return (
		overheadTokens +
		items.reduce(
			(total, item) =>
				total + (item.kind === "observation" ? 0 : projectionCost(item)),
			0,
		)
	);
}

function projectedBudget(items: ContextItem[], options: PinOptions): number {
	let projected = items;
	let estimatedTokens = estimatedCost(projected, options.overheadTokens ?? 0);
	if (estimatedTokens <= options.budget) return estimatedTokens;
	for (const item of evictionCandidates(projected)) {
		const projection =
			item.compactPayload === undefined ? "reference" : "compact";
		if (projectionCost(item, projection) >= projectionCost(item)) continue;
		projected = projected.map((current) =>
			current.id === item.id ? { ...current, projection } : current,
		);
		estimatedTokens = estimatedCost(projected, options.overheadTokens ?? 0);
		if (estimatedTokens <= (options.target ?? options.budget)) break;
	}
	return estimatedTokens;
}

function parseObservationUri(uri: string): ObservationRecallInput {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		throw new Error("Invalid observation URI");
	}
	if (
		parsed.protocol !== "observation:" ||
		!parsed.hostname ||
		(parsed.pathname !== "" && parsed.pathname !== "/") ||
		[...parsed.searchParams.keys()].some(
			(key) => key !== "offset" && key !== "limit",
		) ||
		[...parsed.searchParams.keys()].some(
			(key, index, keys) => keys.indexOf(key) !== index,
		)
	)
		throw new Error("Invalid observation URI");
	return {
		observationId: parsed.hostname,
		...(parsed.searchParams.has("offset")
			? {
					offset: integerParameter(parsed.searchParams.get("offset"), "offset"),
				}
			: {}),
		...(parsed.searchParams.has("limit")
			? { limit: integerParameter(parsed.searchParams.get("limit"), "limit") }
			: {}),
	};
}

function integerParameter(value: string | null, name: string): number {
	if (value === null || !/^(0|[1-9]\d*)$/.test(value))
		throw new Error(`Invalid observation ${name}`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed))
		throw new Error(`Invalid observation ${name}`);
	return parsed;
}

function validateRecallBounds(offset: number, limit: number): void {
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new Error("Invalid observation offset");
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > MAX_OBSERVATION_RECALL_LIMIT
	)
		throw new Error("Invalid observation limit");
}

function characterCost(text: string): number {
	return Math.ceil(text.length / 4);
}

function projectedPayload(item: ContextItem): unknown {
	switch (item.projection) {
		case "compact":
			return item.compactPayload ?? item.payload;
		case "reference":
			return item.compactPayload;
		case "omitted":
			return undefined;
		default:
			return item.payload;
	}
}

function projectionCost(
	item: ContextItem,
	projection: ContextProjection = item.projection,
): number {
	return projection === "full"
		? item.tokenCost
		: projection === "omitted"
			? 0
			: item.compactPayload === undefined
				? projection === "reference"
					? 0
					: item.tokenCost
				: (item.compactTokenCost ?? item.tokenCost);
}

function evictionCandidates(items: ContextItem[]): ContextItem[] {
	return items
		.filter(
			(item) => item.kind === "tool-result" && item.lifecycle === "retained",
		)
		.sort(
			(a, b) => evictionRank(a) - evictionRank(b) || a.sequence - b.sequence,
		);
}

function evictionRank(item: ContextItem): number {
	if (item.source?.isError) return 4;
	if (item.source?.toolName === "write" || item.source?.toolName === "edit")
		return 0;
	if (item.source?.toolName === "read") return 1;
	if (item.source?.toolName === "bash") return 2;
	return 3;
}
