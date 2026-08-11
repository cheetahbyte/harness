import type { SessionStore } from "../session-store";
import { tokenCost } from "../token-cost";
import {
	episodeStates,
	replayEpisodes,
	structuralEvictionCandidates,
	structuralEvictionItems,
} from "./episodes";
import {
	archivedCost,
	archivedProjection,
	assistantText,
	currentCost,
	episodeConclusionPayloads,
	estimatedCost,
	evictionCandidates,
	evictionGroup,
	projectedPayload,
	projectionCost,
	userVisibleAssistant,
} from "./projection";
import {
	DEFAULT_OBSERVATION_RECALL_LIMIT,
	parseObservationUri,
	validateRecallBounds,
} from "./recall";
import {
	ContextBudgetError,
	type ContextEpisode,
	type ContextInspection,
	type ContextItem,
	type ContextKind,
	type ContextLifecycle,
	type ContextSource,
	type InspectOptions,
	type ObservationRecall,
	type ObservationRecallInput,
	type PinKind,
	type PinOptions,
	type RecordInput,
	type SubagentResult,
} from "./types";

export { ContextBudgetError } from "./types";

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

type AssemblyOptions = {
	budget: number;
	target: number;
	overheadTokens: number;
};
type TaskAssemblyOptions = AssemblyOptions & {
	submissionWatermark: number;
	taskStartSequence: number;
	predecessorTerminalIds: readonly string[];
};
type AssemblyState = {
	items: ContextItem[];
	episodes: ContextEpisode[];
	estimatedTokens: number;
};

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
		return episodeStates(items, snapshots);
	}

	/** Retains only user-visible task continuity for future top-level tasks. */
	terminalizeTask(sessionId: string, afterSequence: number): string[] {
		const scoped = this.store
			.contextItems(sessionId)
			.filter((item) => item.sequence > afterSequence);
		const terminal = [...scoped]
			.reverse()
			.find((item) => item.kind === "assistant" && assistantText(item.payload));
		let terminalId: string | undefined;
		for (const item of scoped) {
			if (item.kind === "user" || item.kind === "system") continue;
			this.store.setContextLifecycle(
				item.id,
				"archived",
				"omitted",
				"top-level task terminated",
			);
		}
		if (terminal) {
			const payload = userVisibleAssistant(terminal.payload);
			if (payload) {
				terminalId = this.record({
					sessionId,
					kind: "assistant",
					payload,
					tokenCost: tokenCost(payload, 1),
					lifecycle: "retained",
					reason: "predecessor terminal user-visible message",
					groupId: terminal.groupId ?? crypto.randomUUID(),
				}).id;
			}
		}
		this.activeEpisodes.delete(sessionId);
		return terminalId ? [terminalId] : [];
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
		options: AssemblyOptions,
	): { payloads: unknown[]; estimatedTokens: number; evictedIds: string[] } {
		let state = this.assemblyState(sessionId, options.overheadTokens);
		const evictedIds: string[] = [];
		const underPressure = state.estimatedTokens > options.budget;
		if (underPressure)
			state = this.archiveRetained(sessionId, state, options, evictedIds);
		if (underPressure && state.estimatedTokens > options.target)
			state = this.archiveEpisodes(sessionId, state, options, evictedIds);
		if (underPressure && state.estimatedTokens > options.budget)
			throw new ContextBudgetError(state.estimatedTokens, options.budget);
		return {
			payloads: [
				...state.items.flatMap((item) => {
					if (item.kind === "system" || item.kind === "observation") return [];
					const payload = projectedPayload(item);
					return payload === undefined ? [] : [payload];
				}),
				...episodeConclusionPayloads(state.items, state.episodes),
			],
			estimatedTokens: state.estimatedTokens,
			evictedIds,
		};
	}

	private archiveRetained(
		sessionId: string,
		state: AssemblyState,
		options: AssemblyOptions,
		evictedIds: string[],
	): AssemblyState {
		const activeEpisodes = new Set(
			state.episodes
				.filter((episode) => episode.state !== "completed")
				.map((episode) => episode.id),
		);
		for (const item of evictionCandidates(state.items, activeEpisodes)) {
			if (
				state.items.find((current) => current.id === item.id)?.lifecycle !==
				"retained"
			)
				continue;
			const group = evictionGroup(state.items, item);
			if (archivedCost(group) >= currentCost(group)) continue;
			for (const current of group) {
				this.store.setContextLifecycle(
					current.id,
					"archived",
					archivedProjection(current),
					"working-context budget",
				);
				evictedIds.push(current.id);
			}
			state = this.assemblyState(sessionId, options.overheadTokens);
			if (state.estimatedTokens <= options.target) break;
		}
		return state;
	}

	private archiveEpisodes(
		sessionId: string,
		state: AssemblyState,
		options: AssemblyOptions,
		evictedIds: string[],
	): AssemblyState {
		const tried = new Set<string>();
		while (state.estimatedTokens > options.target) {
			const episode = structuralEvictionCandidates(state.episodes).find(
				(current) => !tried.has(current.id),
			);
			if (!episode) break;
			tried.add(episode.id);
			for (const item of structuralEvictionItems(state.items, episode.id)) {
				if (item.lifecycle === "archived") continue;
				this.store.setContextLifecycle(
					item.id,
					"archived",
					episode.kind === "exploration" ? "omitted" : archivedProjection(item),
					"structural episode eviction",
				);
				evictedIds.push(item.id);
			}
			state = this.assemblyState(sessionId, options.overheadTokens);
		}
		return state;
	}

	private assemblyState(
		sessionId: string,
		overheadTokens: number,
	): AssemblyState {
		const items = this.store.contextItems(sessionId);
		const episodes = this.episodes(sessionId);
		return {
			items,
			episodes,
			estimatedTokens: estimatedCost(items, overheadTokens, episodes),
		};
	}

	assembleTask(
		sessionId: string,
		options: TaskAssemblyOptions,
	): { payloads: unknown[]; estimatedTokens: number; evictedIds: string[] } {
		this.assemble(sessionId, options);
		const terminal = new Set(options.predecessorTerminalIds);
		const items = this.store
			.contextItems(sessionId)
			.filter(
				(item) =>
					item.sequence <= options.submissionWatermark ||
					item.sequence > options.taskStartSequence ||
					terminal.has(item.id),
			);
		const estimatedTokens = items.reduce(
			(total, item) => total + projectionCost(item),
			options.overheadTokens,
		);
		if (estimatedTokens > options.budget)
			throw new ContextBudgetError(estimatedTokens, options.budget);
		return {
			payloads: items.flatMap((item) => {
				if (item.kind === "system" || item.kind === "observation") return [];
				const payload = projectedPayload(item);
				return payload === undefined ? [] : [payload];
			}),
			estimatedTokens,
			evictedIds: [],
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
