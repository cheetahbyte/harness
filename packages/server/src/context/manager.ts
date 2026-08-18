import type { SessionStore } from "../sessions/store";
import type { RuntimeEventSink } from "../telemetry/events";
import { tokenCost as computeTokenCost } from "../token-cost";
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

export const PRESSURE_NOTE_REASON = "working-context pressure";
export const PRESSURE_NOTE =
	"Context is under compaction pressure: older tool output is being archived to observation:// references, which recall_observation reads back. Use episode to bound work that continues past this point, and pin_context for anything later steps must not lose.";
export const PRESSURE_NOTE_TOKENS = computeTokenCost(PRESSURE_NOTE);

/** Marker reason identifying the single live rolling summary item. */
export const ROLLING_SUMMARY_REASON = "rolling summary";
const ROLLING_SUMMARY_PREFIX = "Earlier messages:\n";
/** Cap on a rolling summary's projected size; keeps replacements bounded. */
const ROLLING_SUMMARY_MAX_TOKENS = 400;
/** Most recent pre-submission user messages kept verbatim in task assemblies. */
const RECENT_USER_MESSAGES_KEPT = 2;

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

	private readonly pressureStreak = new Map<string, number>();
	private readonly pressured = new Set<string>();
	constructor(
		private readonly store: SessionStore,
		private readonly sink?: RuntimeEventSink,
	) {}

	markAgentProgress(sessionId: string): void {
		if (this.pressured.has(sessionId))
			this.pressured.add(`${sessionId}:continued`);
	}

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

	private activeEpisodeIds(sessionId: string): Set<string> {
		return new Set(
			this.episodes(sessionId)
				.filter((episode) => episode.state === "active")
				.map((episode) => episode.id),
		);
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
		const activeEpisodeIds = this.activeEpisodeIds(sessionId);
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
		const activeEpisodeIds = this.activeEpisodeIds(sessionId);
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

	/**
	 * Retains the completed task's tail as reclaimable context, preserving the
	 * terminal user-visible assistant message for future top-level tasks. The
	 * original terminal message is reused when its payload is already
	 * user-visible clean; a stripped clone is recorded only when tool-call
	 * blocks must be removed.
	 */
	terminalizeTask(sessionId: string, afterSequence: number): string[] {
		const scoped = this.store
			.contextItems(sessionId)
			.filter((item) => item.sequence > afterSequence);
		const terminal = scoped
			.toReversed()
			.find((item) => item.kind === "assistant" && assistantText(item.payload));
		let terminalId: string | undefined;
		for (const item of scoped) {
			if (
				item.kind === "user" ||
				item.kind === "system" ||
				item.lifecycle === "archived"
			)
				continue;
			const payload =
				item.kind === "assistant"
					? userVisibleAssistant(item.payload)
					: undefined;
			if (payload && JSON.stringify(payload) === JSON.stringify(item.payload)) {
				this.store.setContextLifecycle(
					item.id,
					"retained",
					item.projection,
					"completed top-level task",
				);
				if (item.id === terminal?.id) terminalId = item.id;
				continue;
			}
			this.store.setContextLifecycle(
				item.id,
				"archived",
				"omitted",
				"top-level task terminated",
			);
			if (!payload) continue;
			const clone = this.record({
				sessionId,
				kind: "assistant",
				payload,
				tokenCost: computeTokenCost(payload, 1),
				lifecycle: "retained",
				reason: "completed top-level assistant prose",
				groupId: item.groupId ?? crypto.randomUUID(),
			});
			if (item.id === terminal?.id) terminalId = clone.id;
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
			tokenCost: computeTokenCost(exactOutput),
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
				tokenCost: computeTokenCost(text),
				lifecycle: "pinned",
				reason: `pinned ${kind}`,
			},
			options,
		);
		return item;
	}

	/**
	 * Compaction is otherwise invisible to the model: the placeholders it leaves
	 * behind read as ordinary output, and the budget it works against is never
	 * quoted. Without this note the system prompt's instruction to reach for
	 * episodes under pressure has no observable trigger to fire on.
	 *
	 * Stored rather than synthesized per assembly so it is said exactly once —
	 * a session over budget stays over budget, so a note derived from the live
	 * pressure flag would repeat on every turn for the rest of the session.
	 * Pinned, because the one message explaining the placeholders must not
	 * become a placeholder itself.
	 *
	 * Skipped unless the assembled context can afford it. Pinned weight is
	 * never reclaimed, so a note taken on credit would raise the floor of
	 * every later assembly — advice about a tight budget is not worth being
	 * the reason that budget stops being satisfiable.
	 */
	private notePressure(
		sessionId: string,
		estimatedTokens: number,
		budget: number,
	): void {
		if (estimatedTokens + PRESSURE_NOTE_TOKENS > budget) return;
		if (
			this.store
				.contextItems(sessionId)
				.some((item) => item.reason === PRESSURE_NOTE_REASON)
		)
			return;
		this.record({
			sessionId,
			kind: "pinned-note",
			payload: {
				role: "user",
				content: PRESSURE_NOTE,
				timestamp: Date.now(),
			},
			tokenCost: PRESSURE_NOTE_TOKENS,
			lifecycle: "pinned",
			reason: PRESSURE_NOTE_REASON,
		});
	}

	assemble(
		sessionId: string,
		options: AssemblyOptions,
	): {
		payloads: unknown[];
		estimatedTokens: number;
		evictedIds: string[];
		tokensBefore: number;
		tokensAfter: number;
		episodesArchived: number;
	} {
		let state = this.assemblyState(sessionId, options.overheadTokens);
		const evictedIds: string[] = [];
		const archivedEpisodeIds: string[] = [];
		const tokensBefore = state.estimatedTokens;
		const underPressure = state.estimatedTokens > options.budget;
		if (underPressure)
			state = this.archiveRetained(sessionId, state, options, evictedIds);
		if (underPressure && state.estimatedTokens > options.target)
			state = this.archiveEpisodes(
				sessionId,
				state,
				options,
				evictedIds,
				archivedEpisodeIds,
			);
		if (underPressure && state.estimatedTokens > options.budget)
			state = this.compactPinned(sessionId, state, options, evictedIds);
		if (underPressure && state.estimatedTokens > options.budget)
			throw new ContextBudgetError(state.estimatedTokens, options.budget);
		/**
		 * After the archiving pass, never before it: a note about scarce budget
		 * that competed for that same budget could be the weight that pushes an
		 * assembly past its target. It reaches the model on the next assembly,
		 * which a turn under pressure always performs.
		 */
		if (underPressure)
			this.notePressure(sessionId, state.estimatedTokens, options.budget);
		const pressureStreak = underPressure
			? (this.pressureStreak.get(sessionId) ?? 0) + 1
			: 0;
		if (underPressure) this.pressureStreak.set(sessionId, pressureStreak);
		else this.pressureStreak.delete(sessionId);
		if (underPressure) this.pressured.add(sessionId);
		this.sink?.({
			type: "context.assembly.completed",
			timestamp: new Date().toISOString(),
			sessionId,
			taskId: sessionId,
			turnId: 0,
			assemblyId: Date.now(),
			tokensBefore,
			tokensAfter: state.estimatedTokens,
			budget: options.budget,
			target: options.target,
			underPressure,
			pressureStreak,
			agentContinued: this.pressured.has(`${sessionId}:continued`),
			evictedItems: evictedIds.length,
			archivedEpisodes: archivedEpisodeIds.length,
		});
		if (evictedIds.length)
			this.sink?.({
				type: "context.compaction.completed",
				timestamp: new Date().toISOString(),
				sessionId,
				taskId: sessionId,
				turnId: 0,
				assemblyId: Date.now(),
				trigger: "automatic",
				evictedItems: evictedIds.length,
			});
		return {
			payloads: [
				...projectedPayloads(state.items),
				...episodeConclusionPayloads(state.items, state.episodes),
			],
			estimatedTokens: state.estimatedTokens,
			evictedIds,
			tokensBefore,
			tokensAfter: state.estimatedTokens,
			episodesArchived: archivedEpisodeIds.length,
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
		archivedEpisodeIds: string[],
	): AssemblyState {
		const tried = new Set<string>();
		while (state.estimatedTokens > options.target) {
			const episode = structuralEvictionCandidates(state.episodes).find(
				(current) => !tried.has(current.id),
			);
			if (!episode) break;
			tried.add(episode.id);
			archivedEpisodeIds.push(episode.id);
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

	/**
	 * Pinned content is the last reclaimable layer: collapse the oldest pinned
	 * user history and notes into one rolling summary until the hard budget
	 * fits, keeping the newest content longest (truncation drops the oldest
	 * text first). Nothing is mutated unless a replacement summary can be
	 * seated, so the caller's ContextBudgetError still fires for genuinely
	 * impossible budgets.
	 */
	private compactPinned(
		sessionId: string,
		state: AssemblyState,
		options: AssemblyOptions,
		evictedIds: string[],
	): AssemblyState {
		const candidates = state.items
			.filter(
				(item) =>
					item.lifecycle === "pinned" &&
					(item.kind === "user" || item.kind === "pinned-note") &&
					item.reason !== ROLLING_SUMMARY_REASON,
			)
			.toSorted((a, b) => a.sequence - b.sequence);
		const existing = [...state.items]
			.toReversed()
			.find(
				(item) =>
					item.reason === ROLLING_SUMMARY_REASON &&
					item.lifecycle !== "archived",
			);
		if (!candidates.length && !existing) return state;
		const prior = candidates.length ? existing : undefined;
		if (!candidates.length && existing) candidates.push(existing);
		const priorText = prior ? userText(prior.payload) : undefined;
		const priorCost = prior ? projectionCost(prior) : 0;
		const collapsed: ContextItem[] = [];
		const texts: string[] = [];
		let collapsedCost = 0;
		let content: string | undefined;
		for (const item of candidates) {
			collapsedCost += projectionCost(item);
			collapsed.push(item);
			texts.push(userText(item.payload));
			const room =
				options.budget - (state.estimatedTokens - collapsedCost - priorCost);
			const candidate = rollingSummaryContent(
				priorText,
				texts,
				ROLLING_SUMMARY_MAX_TOKENS,
			);
			if (candidate !== undefined && computeTokenCost(candidate) <= room) {
				content = rollingSummaryContent(priorText, texts, room);
				break;
			}
		}
		if (content === undefined) {
			const room =
				options.budget - (state.estimatedTokens - collapsedCost - priorCost);
			content = rollingSummaryContent(priorText, texts, room);
		}
		if (content === undefined) return state;
		for (const item of collapsed) {
			this.store.setContextLifecycle(
				item.id,
				"archived",
				"omitted",
				"collapsed into rolling summary",
			);
			evictedIds.push(item.id);
		}
		this.appendRollingSummary(sessionId, prior, content);
		return this.assemblyState(sessionId, options.overheadTokens);
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
	): {
		payloads: unknown[];
		estimatedTokens: number;
		evictedIds: string[];
		tokensBefore: number;
		tokensAfter: number;
		episodesArchived: number;
	} {
		const compaction = this.assemble(sessionId, options);
		const terminal = new Set(options.predecessorTerminalIds);
		const inWindow = (item: ContextItem) =>
			item.sequence <= options.submissionWatermark ||
			item.sequence > options.taskStartSequence ||
			terminal.has(item.id);
		this.collapseTaskHistory(
			sessionId,
			this.store.contextItems(sessionId).filter(inWindow),
			options,
			compaction.evictedIds,
		);
		const items = this.store.contextItems(sessionId).filter(inWindow);
		const estimatedTokens = items.reduce(
			(total, item) => total + projectionCost(item),
			options.overheadTokens,
		);
		if (estimatedTokens > options.budget)
			throw new ContextBudgetError(estimatedTokens, options.budget);
		return {
			payloads: projectedPayloads(items),
			estimatedTokens,
			evictedIds: compaction.evictedIds,
			/**
			 * The compaction figures, not this task's filtered projection: a
			 * before/after pair only reads as cleanup if both sides measure the
			 * same thing.
			 */
			tokensBefore: compaction.tokensBefore,
			tokensAfter: compaction.tokensAfter,
			episodesArchived: compaction.episodesArchived,
		};
	}

	/**
	 * Collapses pre-submission user messages (all but the most recent
	 * RECENT_USER_MESSAGES_KEPT) into one rolling summary within the task
	 * window, archiving the replaced originals and any prior summary instead
	 * of accumulating summaries.
	 */
	private collapseTaskHistory(
		sessionId: string,
		window: ContextItem[],
		options: TaskAssemblyOptions,
		evictedIds: string[],
	): void {
		const users = window.filter(
			(item) =>
				item.kind === "user" &&
				item.sequence < options.submissionWatermark &&
				item.lifecycle !== "archived" &&
				item.reason !== ROLLING_SUMMARY_REASON,
		);
		if (users.length <= RECENT_USER_MESSAGES_KEPT) return;
		const targets = users.slice(0, users.length - RECENT_USER_MESSAGES_KEPT);
		const texts = targets.map((item) => userText(item.payload));
		const prior = [...window]
			.toReversed()
			.find(
				(item) =>
					item.reason === ROLLING_SUMMARY_REASON &&
					item.lifecycle !== "archived",
			);
		const priorText = prior ? userText(prior.payload) : undefined;
		const priorCost = prior ? projectionCost(prior) : 0;
		const targetCost = targets.reduce(
			(total, item) => total + projectionCost(item),
			0,
		);
		const baseCost = window.reduce(
			(total, item) => total + projectionCost(item),
			options.overheadTokens,
		);
		const content = rollingSummaryContent(
			priorText,
			texts,
			options.budget - (baseCost - targetCost - priorCost),
		);
		if (content === undefined) return;
		for (const target of targets) {
			this.store.setContextLifecycle(
				target.id,
				"archived",
				"omitted",
				"collapsed into rolling summary",
			);
			evictedIds.push(target.id);
		}
		this.appendRollingSummary(sessionId, prior, content);
	}

	/** Archives the replaced summary (if any) and appends its replacement. */
	private appendRollingSummary(
		sessionId: string,
		prior: ContextItem | undefined,
		content: string,
	): void {
		if (prior)
			this.store.setContextLifecycle(
				prior.id,
				"archived",
				"omitted",
				"replaced by rolling summary",
			);
		this.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content },
			tokenCost: computeTokenCost(content),
			lifecycle: "pinned",
			projection: "full",
			reason: ROLLING_SUMMARY_REASON,
		});
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
			tokenCost: computeTokenCost(result),
			compactTokenCost: computeTokenCost(compactPayload),
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
		let historyTokens = 0;
		let parkedObservations = 0;
		for (const item of items) {
			counts[item.lifecycle]++;
			historyTokens += item.tokenCost;
			if (item.kind === "observation") parkedObservations++;
		}
		return {
			sessionId,
			estimatedTokens: estimatedCost(items, overheadTokens, episodes),
			historyTokens,
			parkedObservations,
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

function projectedPayloads(
	items: ContextItem[],
): NonNullable<ReturnType<typeof projectedPayload>>[] {
	return items.flatMap((item) => {
		if (item.kind === "system" || item.kind === "observation") return [];
		const payload = projectedPayload(item);
		return payload == null ? [] : [payload];
	});
}

function userText(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (!payload || typeof payload !== "object") return "";
	const content = (payload as { content?: unknown }).content;
	return typeof content === "string" ? content : JSON.stringify(payload);
}

/**
 * Deterministic rolling summary: the marker prefix plus the most recent text
 * that fits in `maxTokens` (oldest content is dropped first). Returns
 * undefined when even the bare marker cannot fit.
 */
function rollingSummaryContent(
	priorText: string | undefined,
	texts: string[],
	maxTokens: number,
): string | undefined {
	const joined = [priorText, ...texts]
		.filter((text): text is string => text !== undefined && text.length > 0)
		.join("\n");
	if (joined.length === 0) return undefined;
	const content = `${ROLLING_SUMMARY_PREFIX}${joined}`;
	const maxChars = Math.min(maxTokens, ROLLING_SUMMARY_MAX_TOKENS) * 4;
	if (maxChars < 1) return undefined;
	if (content.length <= maxChars) return content;
	if (maxChars <= ROLLING_SUMMARY_PREFIX.length) return undefined;
	return (
		ROLLING_SUMMARY_PREFIX +
		content
			.slice(ROLLING_SUMMARY_PREFIX.length)
			.slice(-(maxChars - ROLLING_SUMMARY_PREFIX.length))
	);
}
