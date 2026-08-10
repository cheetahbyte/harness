import type { SessionStore } from "./session-store";

export type ContextLifecycle = "pinned" | "active" | "retained" | "archived";
export type ContextProjection = "full" | "compact" | "reference" | "omitted";
type ContextKind =
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

const DEFAULT_OBSERVATION_RECALL_LIMIT = 16 * 1024;
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

export type ContextInspection = {
	sessionId: string;
	estimatedTokens: number;
	counts: Record<ContextLifecycle, number>;
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
		const items = this.store.contextItems(sessionId);
		const retainedGroups = new Set<string>();
		for (const item of items)
			if (
				item.kind === "tool-result" &&
				item.lifecycle === "active" &&
				!newToolCallIds.has(item.source?.toolCallId ?? "")
			) {
				this.store.setContextLifecycle(
					item.id,
					"retained",
					item.projection,
					"consumed by a later model turn",
				);
				if (item.groupId) retainedGroups.add(item.groupId);
			}
		for (const item of items)
			if (
				item.kind === "assistant" &&
				item.lifecycle === "active" &&
				item.groupId &&
				retainedGroups.has(item.groupId)
			)
				this.store.setContextLifecycle(
					item.id,
					"retained",
					item.projection,
					"tool exchange consumed by a later model turn",
				);
	}

	completeGroup(sessionId: string, groupId: string): void {
		for (const item of this.store.contextItems(sessionId))
			if (
				item.groupId === groupId &&
				item.lifecycle === "active" &&
				(item.kind === "user" || item.kind === "assistant")
			)
				this.store.setContextLifecycle(
					item.id,
					"retained",
					item.projection,
					"completed conversation turn",
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
		const payload = { role: "user", content: text, timestamp: Date.now() };
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
				if (
					items.find((current) => current.id === item.id)?.lifecycle !==
					"retained"
				)
					continue;
				const group = evictionGroup(items, item);
				if (archivedCost(group) >= currentCost(group)) continue;
				for (const current of group) {
					const projection = archivedProjection(current);
					this.store.setContextLifecycle(
						current.id,
						"archived",
						projection,
						"working-context budget",
					);
					evictedIds.push(current.id);
				}
				items = this.store.contextItems(sessionId);
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
		const compactPayload = {
			role: "user",
			content: `Subagent handoff:\n${JSON.stringify(result)}`,
			timestamp: Date.now(),
		};
		return this.record({
			sessionId,
			kind: "subagent-handoff",
			payload: result,
			compactPayload,
			tokenCost: Math.ceil(JSON.stringify(result).length / 4),
			compactTokenCost: Math.ceil(JSON.stringify(compactPayload).length / 4),
			lifecycle: "retained",
			projection: "compact",
			reason: "structured subagent handoff",
			source,
		});
	}

	inspect(sessionId: string, overheadTokens = 0): ContextInspection {
		const items = this.store.contextItems(sessionId);
		const counts: Record<ContextLifecycle, number> = {
			pinned: 0,
			active: 0,
			retained: 0,
			archived: 0,
		};
		for (const item of items) counts[item.lifecycle]++;
		return {
			sessionId,
			estimatedTokens: estimatedCost(items, overheadTokens),
			counts,
			items: items.map(
				({
					id,
					sequence,
					kind,
					tokenCost,
					compactTokenCost,
					source,
					groupId,
					episodeId,
					lifecycle,
					projection,
					reason,
					createdAt,
					updatedAt,
				}) => ({
					id,
					sequence,
					kind,
					tokenCost,
					...(compactTokenCost === undefined ? {} : { compactTokenCost }),
					...(source === undefined ? {} : { source }),
					...(groupId === undefined ? {} : { groupId }),
					...(episodeId === undefined ? {} : { episodeId }),
					lifecycle,
					projection,
					reason,
					createdAt,
					updatedAt,
				}),
			),
		};
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
		const group = evictionGroup(projected, item);
		if (archivedCost(group) >= currentCost(group)) continue;
		const ids = new Set(group.map((current) => current.id));
		projected = projected.map((current) =>
			ids.has(current.id)
				? { ...current, projection: archivedProjection(current) }
				: current,
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
			(item) =>
				item.lifecycle === "retained" &&
				(item.kind === "tool-result" ||
					(item.kind === "assistant" &&
						item.groupId !== undefined &&
						!items.some(
							(result) =>
								result.groupId === item.groupId &&
								result.kind === "tool-result" &&
								result.lifecycle === "retained",
						))),
		)
		.sort(
			(a, b) => evictionRank(a) - evictionRank(b) || a.sequence - b.sequence,
		);
}

function evictionGroup(
	items: ContextItem[],
	result: ContextItem,
): ContextItem[] {
	if (!result.groupId) return [result];
	const group = items.filter(
		(item) =>
			item.groupId === result.groupId &&
			item.lifecycle === "retained" &&
			(item.kind === "user" ||
				item.kind === "assistant" ||
				item.kind === "tool-result"),
	);
	return group.length ? group : [result];
}

function archivedProjection(item: ContextItem): ContextProjection {
	if (item.kind === "assistant" || item.kind === "user") return "omitted";
	return item.compactPayload === undefined ? "reference" : "compact";
}

function currentCost(items: ContextItem[]): number {
	return items.reduce((total, item) => total + projectionCost(item), 0);
}

function archivedCost(items: ContextItem[]): number {
	return items.reduce(
		(total, item) => total + projectionCost(item, archivedProjection(item)),
		0,
	);
}

function evictionRank(item: ContextItem): number {
	if (item.kind === "assistant") return 5;
	if (item.source?.isError) return 4;
	if (item.source?.toolName === "write" || item.source?.toolName === "edit")
		return 0;
	if (item.source?.toolName === "read") return 1;
	if (item.source?.toolName === "bash") return 2;
	return 3;
}
