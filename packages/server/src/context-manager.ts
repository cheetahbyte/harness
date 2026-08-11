import type { SessionStore } from "./session-store";
import { tokenCost } from "./token-cost";

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
	evictionPriority?: "early" | "normal" | "late";
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
	private readonly activeEpisodes = new Map<
		string,
		ContextEpisode | undefined
	>();

	constructor(private readonly store: SessionStore) {}

	record(input: RecordInput, options?: PinOptions): ContextItem {
		if (!options) return this.persist(input);
		return this.store.db.transaction(() => {
			const item = this.persist(input);
			this.assemble(input.sessionId, {
				budget: options.budget,
				target: options.target ?? options.budget,
				overheadTokens: options.overheadTokens ?? 0,
			});
			return item;
		})();
	}

	private persist(input: RecordInput): ContextItem {
		const knownKind = kinds.has(input.kind);
		const createdAt = input.createdAt ?? new Date().toISOString();
		const activeEpisode = this.activeEpisode(input.sessionId);
		return this.store.appendContextItem({
			...input,
			id: input.id ?? crypto.randomUUID(),
			...(!("episodeId" in input) && activeEpisode
				? { episodeId: activeEpisode.id }
				: {}),
			kind: knownKind ? input.kind : "pinned-note",
			lifecycle:
				input.kind === "user"
					? "pinned"
					: knownKind && lifecycles.has(input.lifecycle)
						? input.lifecycle
						: "pinned",
			projection: input.projection ?? "full",
			createdAt,
		});
	}

	private activeEpisode(sessionId: string): ContextEpisode | undefined {
		if (!this.activeEpisodes.has(sessionId))
			this.activeEpisodes.set(
				sessionId,
				replayEpisodes(this.store.episodeEvents(sessionId)).find(
					({ episode }) => episode.state === "active",
				)?.episode,
			);
		return this.activeEpisodes.get(sessionId);
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
		const activeEpisodeIds = new Set(
			this.episodes(sessionId)
				.filter((episode) => episode.state === "active")
				.map((episode) => episode.id),
		);
		const retainedGroups = new Set<string>();
		for (const item of items)
			if (
				item.kind === "tool-result" &&
				item.lifecycle === "active" &&
				!activeEpisodeIds.has(item.episodeId ?? "") &&
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
		const activeEpisodeIds = new Set(
			this.episodes(sessionId)
				.filter((episode) => episode.state === "active")
				.map((episode) => episode.id),
		);
		for (const item of this.store.contextItems(sessionId))
			if (
				item.groupId === groupId &&
				item.lifecycle === "active" &&
				!activeEpisodeIds.has(item.episodeId ?? "") &&
				item.kind === "assistant"
			)
				this.store.setContextLifecycle(
					item.id,
					"retained",
					item.projection,
					"completed conversation turn",
				);
	}

	startEpisode(
		sessionId: string,
		input: {
			name: string;
			kind: ContextEpisode["kind"];
			dependencies?: string[];
		},
	): ContextEpisode {
		if (input.kind !== "exploration" && input.kind !== "action")
			throw new Error("Episode kind must be exploration or action");
		const name = input.name.trim();
		if (!name) throw new Error("Episode name cannot be empty");
		const episodes = this.episodes(sessionId);
		if (episodes.some((episode) => episode.state === "active"))
			throw new Error("An episode is already active");
		if (episodes.some((episode) => episode.name === name))
			throw new Error("Episode name must be unique");
		const dependencies = input.dependencies ?? [];
		if (input.kind === "exploration" && dependencies.length)
			throw new Error("Exploration episodes cannot have dependencies");
		if (input.kind === "action") {
			if (!dependencies.length)
				throw new Error("Action episodes require an exploration dependency");
			if (
				dependencies.some(
					(dependency) =>
						!episodes.some(
							(episode) =>
								episode.id === dependency &&
								episode.kind === "exploration" &&
								episode.state !== "active",
						),
				)
			)
				throw new Error(
					"Action dependencies must reference completed exploration episodes",
				);
		}
		const episodeId = crypto.randomUUID();
		this.store.appendEpisodeEvent({
			id: crypto.randomUUID(),
			sessionId,
			episodeId,
			action: "start",
			name,
			kind: input.kind,
			dependencies: [...dependencies],
			createdAt: new Date().toISOString(),
		});
		const episode: ContextEpisode = {
			id: episodeId,
			sessionId,
			name,
			kind: input.kind,
			dependencies: [...dependencies],
			state: "active",
		};
		this.activeEpisodes.set(sessionId, episode);
		return episode;
	}

	endEpisode(sessionId: string, conclusion?: string): ContextEpisode {
		const episode = this.activeEpisode(sessionId);
		if (!episode) throw new Error("No active episode");
		const trimmedConclusion = conclusion?.trim();
		if (episode.kind === "exploration" && !trimmedConclusion)
			throw new Error("Exploration episodes require a conclusion");
		if (episode.kind === "action" && conclusion !== undefined)
			throw new Error("Action episodes cannot have a conclusion");
		this.store.appendEpisodeEvent({
			id: crypto.randomUUID(),
			sessionId,
			episodeId: episode.id,
			action: "end",
			name: episode.name,
			kind: episode.kind,
			dependencies: episode.dependencies,
			...(trimmedConclusion === undefined
				? {}
				: { conclusion: trimmedConclusion }),
			createdAt: new Date().toISOString(),
		});
		const completed: ContextEpisode = {
			...episode,
			state: "completed",
			...(trimmedConclusion === undefined
				? {}
				: { conclusion: trimmedConclusion }),
		};
		this.activeEpisodes.set(sessionId, undefined);
		return completed;
	}

	episodes(sessionId: string): ContextEpisode[] {
		const snapshots = replayEpisodes(this.store.episodeEvents(sessionId));
		const items = this.store.contextItems(sessionId);
		const archivedActionIds = new Set(
			snapshots.flatMap(({ episode, malformed }) => {
				const episodeItems = items.filter(
					(item) => item.episodeId === episode.id,
				);
				return !malformed &&
					episode.kind === "action" &&
					episode.state === "completed" &&
					episodeItems.some(isEpisodeItemEvictable) &&
					episodeItems
						.filter(isEpisodeItemEvictable)
						.every((item) => item.lifecycle === "archived")
					? [episode.id]
					: [];
			}),
		);
		return snapshots.map(({ episode, malformed }) => {
			if (malformed || episode.state !== "completed") return episode;
			const episodeItems = items.filter(
				(item) => item.episodeId === episode.id,
			);
			const archived =
				episodeItems.some(isEpisodeItemEvictable) &&
				episodeItems
					.filter(isEpisodeItemEvictable)
					.every((item) => item.lifecycle === "archived") &&
				(episode.kind === "action" ||
					!snapshots.some(
						({ episode: dependent }) =>
							dependent.kind === "action" &&
							dependent.dependencies.includes(episode.id) &&
							!archivedActionIds.has(dependent.id),
					));
			return archived ? { ...episode, state: "archived" } : episode;
		});
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
			tokenCost: tokenCost(exactOutput),
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

	pin(
		sessionId: string,
		kind: PinKind,
		text: string,
		options: PinOptions,
	): ContextItem {
		if (kind !== "decision" && kind !== "constraint")
			throw new Error("Pinned note kind must be decision or constraint");
		if (!text.trim()) throw new Error("Pinned note cannot be empty");
		const payload = {
			role: "user",
			content: text,
			timestamp: Date.now(),
			kind,
		};
		const item = this.record(
			{
				sessionId,
				kind: "pinned-note",
				payload,
				tokenCost: tokenCost(text),
				lifecycle: "pinned",
				reason: `pinned ${kind}`,
			},
			options,
		);
		return item;
	}

	assemble(
		sessionId: string,
		options: { budget: number; target: number; overheadTokens: number },
	): { payloads: unknown[]; estimatedTokens: number; evictedIds: string[] } {
		let items = this.store.contextItems(sessionId);
		let episodes = this.episodes(sessionId);
		let estimatedTokens = estimatedCost(
			items,
			options.overheadTokens,
			episodes,
		);
		const evictedIds: string[] = [];
		const underPressure = estimatedTokens > options.budget;

		if (underPressure)
			for (const item of evictionCandidates(
				items,
				new Set(
					episodes
						.filter((episode) => episode.state !== "completed")
						.map((episode) => episode.id),
				),
			)) {
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
				episodes = this.episodes(sessionId);
				estimatedTokens = estimatedCost(
					items,
					options.overheadTokens,
					episodes,
				);
				if (estimatedTokens <= options.target) break;
			}

		if (underPressure && estimatedTokens > options.target) {
			const triedEpisodeIds = new Set<string>();
			while (estimatedTokens > options.target) {
				const episode = structuralEvictionCandidates(episodes).find(
					(current) => !triedEpisodeIds.has(current.id),
				);
				if (!episode) break;
				triedEpisodeIds.add(episode.id);
				for (const item of structuralEvictionItems(items, episode.id)) {
					if (item.lifecycle === "archived") continue;
					this.store.setContextLifecycle(
						item.id,
						"archived",
						episode.kind === "exploration"
							? "omitted"
							: archivedProjection(item),
						"structural episode eviction",
					);
					evictedIds.push(item.id);
				}
				items = this.store.contextItems(sessionId);
				episodes = this.episodes(sessionId);
				estimatedTokens = estimatedCost(
					items,
					options.overheadTokens,
					episodes,
				);
				if (estimatedTokens <= options.target) break;
			}
		}

		if (underPressure && estimatedTokens > options.budget)
			throw new ContextBudgetError(estimatedTokens, options.budget);

		return {
			payloads: [
				...items.flatMap((item) => {
					if (item.kind === "system" || item.kind === "observation") return [];
					const payload = projectedPayload(item);
					return payload === undefined ? [] : [payload];
				}),
				...episodeConclusionPayloads(items, episodes),
			],
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

	inspect(
		sessionId: string,
		options: number | InspectOptions = 0,
	): ContextInspection {
		const inspectOptions =
			typeof options === "number" ? { overheadTokens: options } : options;
		const overheadTokens = inspectOptions.overheadTokens ?? 0;
		const items = this.store.contextItems(sessionId);
		const episodes = this.episodes(sessionId);
		const counts: Record<ContextLifecycle, number> = {
			pinned: 0,
			active: 0,
			retained: 0,
			archived: 0,
		};
		for (const item of items) counts[item.lifecycle]++;
		return {
			sessionId,
			estimatedTokens: estimatedCost(items, overheadTokens, episodes),
			...(inspectOptions.budget === undefined
				? {}
				: { budget: inspectOptions.budget }),
			...(inspectOptions.target === undefined
				? {}
				: { target: inspectOptions.target }),
			overheadTokens,
			counts,
			episodes,
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

type EpisodeSnapshot = { episode: ContextEpisode; malformed: boolean };

function replayEpisodes(events: ContextEpisodeEvent[]): EpisodeSnapshot[] {
	const snapshots: EpisodeSnapshot[] = [];
	const byId = new Map<string, EpisodeSnapshot>();
	for (const event of events) {
		if (event.action === "start") {
			const validKind = event.kind === "exploration" || event.kind === "action";
			const duplicate =
				byId.has(event.episodeId) ||
				snapshots.some(({ episode }) => episode.name === event.name);
			const priorEpisodes = snapshots.map(({ episode }) => episode);
			const validDependencies =
				(event.kind === "exploration" && event.dependencies.length === 0) ||
				(event.kind === "action" &&
					event.dependencies.length > 0 &&
					event.dependencies.every((dependency) =>
						priorEpisodes.some(
							(episode) =>
								episode.id === dependency &&
								episode.kind === "exploration" &&
								episode.state === "completed",
						),
					));
			if (!validKind || duplicate || !event.name.trim()) continue;
			const snapshot: EpisodeSnapshot = {
				episode: {
					id: event.episodeId,
					sessionId: event.sessionId,
					name: event.name,
					kind: event.kind,
					dependencies: [...event.dependencies],
					state: "active",
				},
				malformed: !validDependencies,
			};
			snapshots.push(snapshot);
			byId.set(event.episodeId, snapshot);
			continue;
		}
		const snapshot = byId.get(event.episodeId);
		if (snapshot?.episode.state !== "active") continue;
		const matchingBoundary =
			event.name === snapshot.episode.name &&
			event.kind === snapshot.episode.kind &&
			event.dependencies.length === snapshot.episode.dependencies.length &&
			event.dependencies.every(
				(dependency, index) =>
					dependency === snapshot.episode.dependencies[index],
			);
		const validConclusion =
			snapshot.episode.kind === "exploration"
				? !!event.conclusion?.trim()
				: event.conclusion === undefined;
		if (!matchingBoundary || !validConclusion) {
			snapshot.malformed = true;
			continue;
		}
		snapshot.episode = {
			...snapshot.episode,
			state: "completed",
			...(event.conclusion === undefined
				? {}
				: { conclusion: event.conclusion }),
		};
	}
	return snapshots;
}

function isEpisodeItemEvictable(item: ContextItem): boolean {
	return item.kind !== "user" && item.lifecycle !== "pinned";
}

function structuralEvictionCandidates(
	episodes: ContextEpisode[],
): ContextEpisode[] {
	const actions = episodes.filter(
		(episode) => episode.kind === "action" && episode.state === "completed",
	);
	if (actions.length) return actions;
	return episodes.filter(
		(episode) =>
			episode.kind === "exploration" &&
			episode.state === "completed" &&
			!episodes.some(
				(dependent) =>
					dependent.kind === "action" &&
					dependent.dependencies.includes(episode.id) &&
					dependent.state !== "archived",
			),
	);
}

function structuralEvictionItems(
	items: ContextItem[],
	episodeId: string,
): ContextItem[] {
	const result = new Map<string, ContextItem>();
	for (const item of items) {
		if (item.episodeId !== episodeId || !isEpisodeItemEvictable(item)) continue;
		const group = item.groupId
			? items.filter((current) => current.groupId === item.groupId)
			: [item];
		if (
			group.some(
				(current) =>
					current.episodeId !== episodeId || !isEpisodeItemEvictable(current),
			)
		)
			continue;
		for (const current of group) result.set(current.id, current);
	}
	return [...result.values()].sort((a, b) => a.sequence - b.sequence);
}

function episodeConclusionPayloads(
	items: ContextItem[],
	episodes: ContextEpisode[],
): Array<{ role: "user"; content: string }> {
	return episodes.flatMap((episode) => {
		if (
			episode.kind !== "exploration" ||
			episode.state !== "archived" ||
			episode.conclusion === undefined
		)
			return [];
		const references = [
			...new Set(
				items
					.filter((item) => item.episodeId === episode.id)
					.flatMap((item) =>
						item.source?.observationId ? [item.source.observationId] : [],
					),
			),
		];
		return [
			{
				role: "user",
				content: `Exploration conclusion (${episode.name}): ${episode.conclusion}${references.length ? `\nObservation references: ${references.map((id) => `observation://${id}`).join(", ")}` : ""}`,
			},
		];
	});
}

function estimatedCost(
	items: ContextItem[],
	overheadTokens: number,
	episodes: ContextEpisode[] = [],
): number {
	return (
		overheadTokens +
		items.reduce(
			(total, item) =>
				total + (item.kind === "observation" ? 0 : projectionCost(item)),
			0,
		) +
		episodeConclusionPayloads(items, episodes).reduce(
			(total, payload) => total + tokenCost(payload.content),
			0,
		)
	);
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

function evictionCandidates(
	items: ContextItem[],
	protectedEpisodeIds = new Set<string>(),
): ContextItem[] {
	return items
		.filter(
			(item) =>
				item.lifecycle === "retained" &&
				(item.episodeId === undefined ||
					!protectedEpisodeIds.has(item.episodeId)) &&
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
			(item.kind === "assistant" || item.kind === "tool-result"),
	);
	return group.length ? group : [result];
}

function archivedProjection(item: ContextItem): ContextProjection {
	if (item.kind === "assistant") return "omitted";
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
	return (
		{ early: 0, normal: 1, late: 2 }[
			item.source?.evictionPriority ?? "normal"
		] ?? 1
	);
}
