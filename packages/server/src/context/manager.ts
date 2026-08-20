import { structuredHash } from "../capabilities/hash";
import type { SessionStore } from "../sessions/store";
import type { RuntimeEventSink } from "../telemetry/events";
import { telemetryPrefixAlias } from "../telemetry/runtime";
import { tokenCost as computeTokenCost } from "../token-cost";
import {
	MEMORY_REASON,
	MEMORY_MAX_TOKENS,
	type CondensationInput,
	memoryTokenCost,
	mergeCondensationMemory,
	parseCondensationMemory,
	selectCondensationItems,
	validateCondensationInput,
} from "./condensation";
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
	projectedPathPayloads,
	projectionCost,
	validCheckpoint,
	userVisibleAssistant,
} from "./projection";
import {
	DEFAULT_OBSERVATION_RECALL_LIMIT,
	parseObservationUri,
	validateRecallBounds,
} from "./recall";
import {
	ContextBudgetError,
	type FinishContextTaskRequest,
	type ContextCheckpointPayload,
	type CheckpointRepresentation,
	type PreparedTurn,
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
	type SourceRange,
	type SubagentResult,
} from "./types";

type ContextCompactionRequest = {
	messages: unknown[];
	previousMemory?: CondensationInput;
	anchors: string[];
	targetMemoryTokens: number;
	signal: AbortSignal;
};
export type ContextCompactor = (request: ContextCompactionRequest) => Promise<
	| {
			memory: CondensationInput;
			provider?: string;
			model?: string;
			inputTokens?: number;
			outputTokens?: number;
			cacheReadTokens?: number;
			cacheWriteTokens?: number;
			retries?: number;
	  }
	| undefined
>;

export { ContextBudgetError } from "./types";

const kinds = new Set<ContextKind>([
	"system",
	"user",
	"assistant",
	"tool-result",
	"observation",
	"pinned-note",
	"subagent-handoff",
	"long-term-memory",
]);
const STALE_COMPACTION_PLAN = "stale context compaction plan";
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

export type CondensationOptions = {
	overheadTokens?: number;
	budget?: number;
	target?: number;
	currentTaskStartSequence?: number;
	predecessorTerminalIds?: readonly string[];
	taskId?: string;
	turnId?: number;
};

export type PrepareTurnRequest = {
	sessionId: string;
	taskId: string;
	laneId: string;
	pendingInput?: RecordInput[];
	fixedMessages: unknown[];
	capabilityMessages: unknown[];
	tools: unknown[];
	prefixTools?: unknown[];
	budget: number;
	signal: AbortSignal;
	overheadTokens?: number;
	compactor?: ContextCompactor;
	provider?: string;
	model?: string;
	serializerVersion?: string;
	systemPrompt?: string;
	/** Internal retry count used when an async compaction plan goes stale. */
	stalePlanCount?: number;
};

export type CondensationResult = {
	noOp: boolean;
	assemblyId?: number;
	milestone: string;
	archivedItems: number;
	archivedEpisodes: number;
	tokensBefore: number;
	tokensAfter: number;
	memoryTokens: number;
};

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
	taskId?: string;
	turnId?: number;
	trigger?:
		| "initial"
		| "transform-context"
		| "prepare-next-turn"
		| "shrink"
		| "explicit";
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
	private readonly telemetryKey: Uint8Array;
	private readonly activeEpisodes = new Map<
		string,
		ContextEpisode | undefined
	>();

	private readonly pressureStreak = new Map<string, number>();
	private readonly pressured = new Set<string>();
	private readonly assemblyIds = new Map<string, number>();
	constructor(
		private readonly store: SessionStore,
		private readonly sink?: RuntimeEventSink,
	) {
		this.telemetryKey = store.telemetryInstallKey();
	}

	forkLane(request: {
		sessionId: string;
		name: string;
		ownerTaskId: string;
		fromItemId: string;
	}): import("./types").ContextLane {
		return this.store.startChildContextTask({
			sessionId: request.sessionId,
			name: request.name,
			taskId: request.ownerTaskId,
			fromItemId: request.fromItemId,
			startedAt: new Date().toISOString(),
		});
	}

	finishTask(request: FinishContextTaskRequest): void {
		const laneName = request.laneId ?? "main";
		const episode = request.episodeId
			? this.episodes(request.sessionId).find(
					(item) => item.id === request.episodeId && item.state === "active",
				)
			: this.episodes(request.sessionId).find(
					(item) => item.state === "active",
				);
		const terminalEpisode = episode
			? {
					id: crypto.randomUUID(),
					sessionId: request.sessionId,
					episodeId: episode.id,
					action:
						request.status === "failed"
							? ("failed" as const)
							: request.status === "cancelled" ||
								  request.status === "superseded"
								? ("cancelled" as const)
								: episode.kind === "action"
									? ("end" as const)
									: ("abandoned" as const),
					name: episode.name,
					kind: episode.kind,
					dependencies: episode.dependencies,
					createdAt: new Date().toISOString(),
				}
			: undefined;
		const handoffPayload = request.handoff
			? {
					role: "user" as const,
					content: `Subagent handoff:\n${JSON.stringify(request.handoff)}`,
					timestamp: Date.now(),
				}
			: undefined;
		const handoff =
			request.handoff && handoffPayload
				? {
						id: `handoff-${request.taskId}`,
						sessionId: request.sessionId,
						kind: "subagent-handoff" as const,
						payload: request.handoff,
						compactPayload: handoffPayload,
						tokenCost: computeTokenCost(request.handoff),
						compactTokenCost: computeTokenCost(handoffPayload),
						lifecycle: "retained" as const,
						projection: "compact" as const,
						reason: "structured subagent handoff",
						source: { subagentId: laneName },
						createdAt: new Date().toISOString(),
					}
				: undefined;
		this.store.finishContextTask({
			sessionId: request.sessionId,
			taskId: request.taskId,
			status: request.status,
			startedAt: request.startedAt ?? new Date().toISOString(),
			laneName,
			...(request.ledger ? { ledger: request.ledger } : {}),
			...(terminalEpisode ? { terminalEpisode } : {}),
			...(handoff ? { handoff } : {}),
		});
		this.activeEpisodes.delete(request.sessionId);
	}

	recover(sessionId?: string): {
		repaired: number;
		abandoned: number;
		failed: number;
		episodes: number;
	} {
		const startedAt = performance.now();
		const result = this.store.recoverLanes(sessionId);
		this.activeEpisodes.clear();
		if (sessionId)
			this.sink?.({
				type: "context.recovery.completed",
				timestamp: new Date().toISOString(),
				sessionId,
				lane: "all",
				origin: "task-admission",
				trigger: "startup-recovery",
				repairedLanes: result.repaired,
				abandonedLanes: result.abandoned,
				failedTasks: result.failed,
				repairedEpisodes: result.episodes,
				durationMs: performance.now() - startedAt,
				retries: 0,
				stalePlan: false,
			});
		return result;
	}

	markAgentProgress(scopeId: string): void {
		if (this.pressured.has(scopeId)) this.pressured.add(`${scopeId}:continued`);
	}
	clearPressure(scopeId: string): void {
		this.pressureStreak.delete(scopeId);
		this.pressured.delete(scopeId);
		this.pressured.delete(`${scopeId}:continued`);
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

	/**
	 * Prepares a provider turn and guarantees deterministic progress when the
	 * fixed envelope plus pending input can fit. Remote condensation is added by
	 * the runtime task; this method is intentionally synchronous internally so
	 * existing callers remain compatible.
	 */
	async prepareTurn(request: PrepareTurnRequest): Promise<PreparedTurn> {
		if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
		const lane = this.store.lane(request.sessionId, request.laneId);
		if (!lane) throw new Error(`Unknown context lane ${request.laneId}`);
		const fixed = [...request.fixedMessages, ...request.capabilityMessages];
		const fixedCost = fixed.reduce<number>(
			(sum, value) => sum + tokenCostOf(value),
			tokenCostOf(request.tools) + (request.overheadTokens ?? 0),
		);
		const pending = (request.pendingInput ?? []).map((input) =>
			this.projectPendingUser(input, request.budget - fixedCost),
		);
		const pendingMessages = pending.map(projectedPendingPayload);
		const pendingCost = pending.reduce<number>(
			(sum, input) => sum + projectedPendingCost(input),
			0,
		);
		const path = this.store.contextPath(request.sessionId, request.laneId);
		const stalePlanCount = request.stalePlanCount ?? 0;
		let messages = [
			...fixed,
			...projectedPathPayloads(path, this.episodes(request.sessionId)),
			...pendingMessages,
		];
		let estimatedTokens =
			fixedCost + pendingCost + this.pathProjectedCost(path, request.sessionId);
		const startedAt = performance.now();
		const prefixAlias = telemetryPrefixAlias(
			{
				provider: request.provider ?? "unknown",
				model: request.model ?? "unknown",
				serializerVersion: request.serializerVersion ?? "context-v1",
				system: request.systemPrompt ?? fixed[0],
				fixed,
				capabilities: request.capabilityMessages,
				tools: request.prefixTools ?? request.tools,
				messages: projectedPathPayloads(path, this.episodes(request.sessionId)),
			},
			this.telemetryKey,
		);
		this.sink?.({
			type: "context.prepare",
			timestamp: new Date().toISOString(),
			sessionId: request.sessionId,
			taskId: request.taskId,
			lane: request.laneId,
			origin: request.laneId,
			trigger: "turn",
			beforeTokens: estimatedTokens,
			headroomTokens: request.budget - estimatedTokens,
			budget: request.budget,
			prefixAlias,
			stalePlan: stalePlanCount > 0,
			...(request.provider ? { provider: request.provider } : {}),
			...(request.model ? { model: request.model } : {}),
		});
		const shouldCompact =
			estimatedTokens >= Math.floor(request.budget * 0.8) &&
			request.compactor !== undefined;
		if (estimatedTokens <= request.budget && !shouldCompact) {
			request.signal.throwIfAborted();
			this.store.db.transaction(() => {
				for (const input of pending)
					this.appendAtLaneHead(input, request.sessionId, request.laneId);
			})();
			return { messages, estimatedTokens, usedFallback: false };
		}
		if (fixedCost + pendingCost > request.budget)
			throw new ContextBudgetError(
				fixedCost + pendingCost,
				request.budget,
				"INPUT_TOO_LARGE",
			);

		let representation = this.fallbackRepresentation(
			path,
			this.episodes(request.sessionId),
		);
		let compactorDraft: Awaited<ReturnType<ContextCompactor>>;
		let sourceCount = 0;
		let sourceTokens = 0;
		let retainedTail: unknown[] = [];
		if (shouldCompact || estimatedTokens > request.budget) {
			this.sink?.({
				type: "context.compaction.started",
				timestamp: new Date().toISOString(),
				sessionId: request.sessionId,
				taskId: request.taskId,
				lane: request.laneId,
				origin: request.laneId,
				trigger: shouldCompact ? "automatic" : "budget",
				beforeTokens: estimatedTokens,
				prefixAlias,
				stalePlan: stalePlanCount > 0,
				...(request.provider ? { provider: request.provider } : {}),
				...(request.model ? { model: request.model } : {}),
			});
			const projected = projectedPathPayloads(
				path,
				this.episodes(request.sessionId),
			);
			const tailBudget = Math.min(
				20_000,
				Math.max(
					0,
					Math.floor(request.budget * 0.6) - fixedCost - pendingCost - 2_000,
				),
			);
			const currentTurn = projected.findLastIndex(
				(payload) =>
					!!payload &&
					typeof payload === "object" &&
					(payload as { role?: unknown }).role === "user",
			);
			const tailStart = pending.length
				? projected.length
				: currentTurn < 0
					? projected.length - 1
					: currentTurn;
			retainedTail =
				tailStart >= projected.length ? [] : projected.slice(tailStart);
			let tailCost = retainedTail.reduce<number>(
				(sum, value) => sum + tokenCostOf(value),
				0,
			);
			if (tailCost > request.budget - fixedCost - pendingCost)
				throw new ContextBudgetError(
					fixedCost + pendingCost + tailCost,
					request.budget,
					"INPUT_TOO_LARGE",
				);
			for (let index = tailStart - 1; index >= 0; index--) {
				const cost = tokenCostOf(projected[index]);
				if (tailCost + cost > tailBudget) break;
				retainedTail.unshift(projected[index]);
				tailCost += cost;
			}
			const compactor = request.compactor;
			const source = projected.slice(0, projected.length - retainedTail.length);
			sourceCount = source.length;
			sourceTokens = source.reduce<number>(
				(sum, value) => sum + tokenCostOf(value),
				0,
			);
			const sourceFitsCompactor = sourceTokens + 4_096 <= request.budget;
			if (compactor && source.length && sourceFitsCompactor) {
				const previous = path
					.toReversed()
					.map((item) => validCheckpoint(item))
					.find((item) => item?.representation.kind === "condensation");
				try {
					compactorDraft = await compactor({
						messages: source,
						...(previous?.representation.kind === "condensation"
							? {
									previousMemory: previous.representation
										.memory as CondensationInput,
								}
							: {}),
						anchors: path
							.filter(
								(item) => item.kind === "pinned-note" || item.kind === "user",
							)
							.map((item) => String(item.payload))
							.slice(-12),
						targetMemoryTokens: 2_000,
						signal: request.signal,
					});
				} catch {
					compactorDraft = undefined;
				}
				if (
					this.store.lane(request.sessionId, request.laneId)?.revision !==
					lane.revision
				) {
					const nextStalePlanCount = stalePlanCount + 1;
					this.sink?.({
						type: "context.compaction.failed",
						timestamp: new Date().toISOString(),
						sessionId: request.sessionId,
						taskId: request.taskId,
						lane: request.laneId,
						origin: request.laneId,
						trigger: "automatic",
						beforeTokens: estimatedTokens,
						sourceCount,
						sourceTokens,
						retries: nextStalePlanCount,
						stalePlan: true,
						durationMs: performance.now() - startedAt,
						error: "stale_compaction_plan",
						prefixAlias,
					});
					const { compactor: _compactor, ...retryRequest } = request;
					return this.prepareTurn({
						...retryRequest,
						stalePlanCount: nextStalePlanCount,
					});
				}
				if (!compactorDraft)
					this.sink?.({
						type: "context.compaction.failed",
						timestamp: new Date().toISOString(),
						sessionId: request.sessionId,
						taskId: request.taskId,
						lane: request.laneId,
						origin: request.laneId,
						trigger: "automatic",
						beforeTokens: estimatedTokens,
						sourceCount,
						sourceTokens,
						retries: 1,
						stalePlan: false,
						durationMs: performance.now() - startedAt,
						error: "llm_compaction_failed",
						prefixAlias,
						...(request.provider ? { provider: request.provider } : {}),
						...(request.model ? { model: request.model } : {}),
					});
				if (compactorDraft)
					representation = {
						kind: "condensation",
						memory: compactorDraft.memory,
					};
			}
		}
		request.signal.throwIfAborted();
		let checkpoint: ContextItem;
		try {
			checkpoint = this.store.db.transaction(() => {
				if (
					this.store.lane(request.sessionId, request.laneId)?.revision !==
					lane.revision
				)
					throw new Error(STALE_COMPACTION_PLAN);
				const committed = this.appendCheckpoint(
					request.sessionId,
					request.laneId,
					representation,
					retainedTail,
					{
						condensedCount: Math.max(0, path.length - retainedTail.length),
						retainedCount: retainedTail.length,
					},
				);
				for (const input of pending)
					this.appendAtLaneHead(input, request.sessionId, request.laneId);
				return committed;
			})();
		} catch (error) {
			if (!(error instanceof Error) || error.message !== STALE_COMPACTION_PLAN)
				throw error;
			const { compactor: _compactor, ...retryRequest } = request;
			return this.prepareTurn({
				...retryRequest,
				stalePlanCount: stalePlanCount + 1,
			});
		}
		const after = this.store.contextPath(request.sessionId, request.laneId);
		messages = [
			...fixed,
			...projectedPathPayloads(after, this.episodes(request.sessionId)),
		];
		estimatedTokens =
			fixedCost +
			projectedPathPayloads(
				after,
				this.episodes(request.sessionId),
			).reduce<number>((sum, payload) => sum + tokenCostOf(payload), 0);
		if (estimatedTokens > request.budget) {
			// The fallback has no summary/tail; only fixed + pending can remain.
			messages = [...fixed, ...pendingMessages];
			estimatedTokens = fixedCost + pendingCost;
		}
		this.sink?.({
			type: "context.compaction.completed",
			timestamp: new Date().toISOString(),
			sessionId: request.sessionId,
			taskId: request.taskId,
			lane: request.laneId,
			origin: request.laneId,
			trigger:
				representation.kind === "condensation" ? "automatic-llm" : "fallback",
			beforeTokens:
				fixedCost +
				pendingCost +
				this.pathProjectedCost(path, request.sessionId),
			afterTokens: estimatedTokens,
			sourceCount,
			sourceTokens,
			...(compactorDraft?.inputTokens === undefined
				? {}
				: { inputTokens: compactorDraft.inputTokens }),
			outputTokens:
				compactorDraft?.outputTokens ??
				(representation.kind === "condensation"
					? tokenCostOf(representation.memory)
					: 0),
			cacheReadTokens: compactorDraft?.cacheReadTokens ?? 0,
			cacheWriteTokens: compactorDraft?.cacheWriteTokens ?? 0,
			headroomTokens: request.budget - estimatedTokens,
			durationMs: performance.now() - startedAt,
			retries: (compactorDraft?.retries ?? 0) + stalePlanCount,
			prefixAlias,
			stalePlan: stalePlanCount > 0,
			...((compactorDraft?.provider ?? request.provider)
				? { provider: compactorDraft?.provider ?? request.provider }
				: {}),
			...((compactorDraft?.model ?? request.model)
				? { model: compactorDraft?.model ?? request.model }
				: {}),
		});
		return {
			messages,
			estimatedTokens,
			checkpointId: checkpoint.id,
			usedFallback: representation.kind === "fallback",
		};
	}

	private projectPendingUser(
		input: RecordInput,
		maxTokens: number,
	): RecordInput {
		if (input.kind !== "user") return input;
		const id = input.id ?? crypto.randomUUID();
		const text = userText(input.payload);
		const source = { ...input.source, observationId: id };
		if (tokenCostOf(input.payload) <= maxTokens)
			return { ...input, id, source };
		const reference = referencedUserProjection(input.payload, id, maxTokens);
		return {
			...input,
			id,
			source: {
				...source,
				totalCharacters: text.length,
				previewedRanges: reference.previewedRanges,
			},
			compactPayload: reference.payload,
			compactTokenCost: tokenCostOf(reference.payload),
			projection: "reference",
		};
	}

	recoverProviderOverflow(
		sessionId: string,
		laneName = "main",
		stage: "reference" | "minimal-reference" = "reference",
	): void {
		const path = this.store.contextPath(sessionId, laneName);
		const currentTurn = path.findLastIndex((item) => item.kind === "user");
		const user = currentTurn < 0 ? undefined : path[currentTurn];
		const reference = user
			? stage === "reference" && user.compactPayload !== undefined
				? user.compactPayload
				: referencedUserProjection(
						user.payload,
						user.source?.observationId ?? user.id,
						stage === "reference" ? 2_048 : 0,
					).payload
			: undefined;
		const retainedTail = user
			? [
					reference,
					...path.slice(currentTurn + 1).flatMap((item) => {
						const payload = projectedPayload(item);
						return payload === undefined ? [] : [payload];
					}),
				]
			: [];
		const checkpoint = this.store.db.transaction(() => {
			return this.appendCheckpoint(
				sessionId,
				laneName,
				this.fallbackRepresentation(path, this.episodes(sessionId)),
				retainedTail,
				{
					condensedCount: Math.max(0, path.length - retainedTail.length),
					retainedCount: retainedTail.length,
				},
			);
		})();
		this.sink?.({
			type: "context.recovery.completed",
			timestamp: new Date().toISOString(),
			sessionId,
			lane: laneName,
			origin: laneName,
			trigger: "provider-context-length",
			checkpointId: checkpoint.id,
			laneRevision: this.store.lane(sessionId, laneName)?.revision ?? 0,
			repairedItems: path.length,
			retainedItems: retainedTail.length,
			repairedEpisodes: this.episodes(sessionId).length,
			retries: stage === "reference" ? 1 : 2,
			stalePlan: false,
		});
	}

	private pathProjectedCost(
		path: readonly ContextItem[],
		sessionId: string,
	): number {
		const payloads = projectedPathPayloads(path, this.episodes(sessionId));
		if (!path.some((item) => item.nodeRole === "checkpoint"))
			return path.reduce(
				(sum, item) =>
					sum + (item.kind === "observation" ? 0 : projectionCost(item)),
				0,
			);
		return payloads.reduce<number>(
			(sum, payload) => sum + tokenCostOf(payload),
			0,
		);
	}

	private appendAtLaneHead(
		input: RecordInput,
		sessionId: string,
		laneName: string,
	): ContextItem {
		const lane = this.store.lane(sessionId, laneName);
		if (!lane) throw new Error(`Unknown context lane ${laneName}`);
		const result = this.store.appendContextAtHead(
			{
				...input,
				id: input.id ?? crypto.randomUUID(),
				createdAt: input.createdAt ?? new Date().toISOString(),
				projection: input.projection ?? "full",
				originLane: laneName,
			},
			laneName,
			lane.revision,
		);
		if ("status" in result)
			throw new Error("Context lane changed while appending");
		return result;
	}

	private fallbackRepresentation(
		path: readonly ContextItem[],
		episodes: readonly ContextEpisode[] = [],
	): CheckpointRepresentation {
		const activeIds = new Set(
			episodes
				.filter((episode) => episode.state === "active")
				.map((episode) => episode.id),
		);
		const anchors = path
			.filter(
				(item) =>
					item.episodeId !== undefined &&
					activeIds.has(item.episodeId) &&
					item.kind !== "observation",
			)
			.toReversed()
			.slice(0, 8)
			.toReversed()
			.map((item) => boundedText(item.payload, 240));
		const goals = episodes
			.filter((episode) => episode.state === "active")
			.map((episode) => boundedText(episode.name, 160))
			.slice(0, 4);
		const conclusions = episodes
			.filter((episode) => episode.conclusion !== undefined)
			.map((episode) =>
				boundedText(`${episode.name}: ${episode.conclusion}`, 320),
			)
			.slice(-4);
		const references = [
			...new Set(
				path
					.filter((item) => activeIds.has(item.episodeId ?? ""))
					.flatMap((item) =>
						item.source?.observationId
							? [`observation://${item.source.observationId}`]
							: [],
					),
			),
		].slice(0, 8);
		const summary = JSON.stringify({ goals, anchors, conclusions });
		return { kind: "fallback", summary, references };
	}

	private appendCheckpoint(
		sessionId: string,
		laneName: string,
		representation: CheckpointRepresentation,
		retainedTail: unknown[] = [],
		coverageCounts: {
			condensedCount?: number;
			retainedCount?: number;
			references?: string[];
			omittedDigest?: string;
		} = {},
	): ContextItem {
		const lane = this.store.lane(sessionId, laneName);
		if (!lane) throw new Error(`Unknown context lane ${laneName}`);
		const path = this.store.contextPath(sessionId, laneName);
		const coveredThroughId = path.at(-1)?.id;
		const baseCheckpoint = path.findLast(
			(item) => item.nodeRole === "checkpoint",
		);
		const baseIndex = baseCheckpoint ? path.lastIndexOf(baseCheckpoint) : -1;
		const sourceItems = path
			.slice(baseIndex + 1)
			.filter((item) => item.nodeRole !== "checkpoint");
		const condensedCount = Math.min(
			coverageCounts.condensedCount ?? 0,
			sourceItems.length,
		);
		const retainedCount = Math.min(
			coverageCounts.retainedCount ?? 0,
			sourceItems.length - condensedCount,
		);
		const omittedCount = sourceItems.length - condensedCount - retainedCount;
		const coverageDigest = structuredHash(
			sourceItems.map(({ id, contentHash }) => ({ id, contentHash })),
		);
		const sourceDigest = structuredHash({
			policyVersion: 1,
			...(baseCheckpoint?.sourceDigest
				? { base: baseCheckpoint.sourceDigest }
				: {}),
			items: sourceItems.map(({ id, contentHash }) => ({ id, contentHash })),
		});
		const payload: ContextCheckpointPayload = {
			schemaVersion: 1,
			...(coveredThroughId === undefined ? {} : { coveredThroughId }),
			...(baseCheckpoint?.id ? { baseCheckpointId: baseCheckpoint.id } : {}),
			baseRevision: lane.revision,
			omittedDigest: coverageCounts.omittedDigest ?? coverageDigest,
			coverage: {
				sourceCount: sourceItems.length,
				condensedCount,
				retainedCount,
				omittedCount,
				omittedDigest: coverageCounts.omittedDigest ?? coverageDigest,
				references: (coverageCounts.references ?? []).slice(0, 8),
			},
			sourceDigest,
			policyVersion: 1,
			representation,
			retainedTail,
		};
		const result = this.store.appendContextAtHead(
			{
				id: crypto.randomUUID(),
				sessionId,
				createdAt: new Date().toISOString(),
				originLane: laneName,
				nodeRole: "checkpoint",
				kind: "long-term-memory",
				payload,
				sourceDigest,
				policyVersion: 1,
				tokenCost: computeTokenCost(payload),
				lifecycle: "pinned",
				projection: "full",
				reason:
					representation.kind === "fallback"
						? "deterministic fallback"
						: MEMORY_REASON,
			},
			laneName,
			lane.revision,
		);
		if ("status" in result)
			throw new Error("Context lane changed while checkpointing");
		return result;
	}

	condense(
		sessionId: string,
		input: CondensationInput,
		options: CondensationOptions = {},
	): CondensationResult {
		const next = validateCondensationInput(input);
		const scopeId = options.taskId ?? sessionId;
		const assemblyId =
			(this.assemblyIds.set(scopeId, (this.assemblyIds.get(scopeId) ?? 0) + 1),
			this.assemblyIds.get(scopeId)!);
		const items = this.store.contextItems(sessionId);
		const priorItem = items
			.toReversed()
			.find(
				(item) =>
					item.nodeRole === "checkpoint" && item.lifecycle !== "archived",
			);
		const priorCheckpoint = priorItem ? validCheckpoint(priorItem) : undefined;
		const prior =
			priorCheckpoint?.representation.kind === "condensation"
				? (
						priorCheckpoint.representation as {
							kind: "condensation";
							memory: CondensationInput;
						}
					).memory
				: priorItem
					? parseCondensationMemory(priorItem.payload)
					: undefined;
		const merged = mergeCondensationMemory(prior, next);
		const memoryTokens = memoryTokenCost(merged);
		if (memoryTokens > MEMORY_MAX_TOKENS)
			throw new Error("Condensation memory exceeds 2,000 tokens");
		const latestCheckpoint = items
			.map((item, index) => ({ item, index }))
			.filter(({ item }) => validCheckpoint(item) !== undefined)
			.at(-1);
		const baseCheckpoint = latestCheckpoint?.item;
		const sourceItems = latestCheckpoint
			? items.slice(latestCheckpoint.index + 1)
			: items;
		const eligible = selectCondensationItems(sourceItems, options);
		const tokensBefore = latestCheckpoint
			? projectedEstimatedCost(
					this.store.contextPath(sessionId, "main"),
					options.overheadTokens ?? 0,
					this.episodes(sessionId),
				)
			: estimatedCost(
					items,
					options.overheadTokens ?? 0,
					this.episodes(sessionId),
				);
		if (!eligible.length)
			return {
				noOp: true,
				assemblyId,
				milestone: next.milestone,
				archivedItems: 0,
				archivedEpisodes: 0,
				tokensBefore,
				tokensAfter: tokensBefore,
				memoryTokens,
			};
		const tailGroups = new Set(
			items
				.toReversed()
				.filter((item) => item.groupId)
				.map((item) => item.groupId!)
				.slice(0, 4),
		);
		const eligibleIds = new Set(eligible.map((item) => item.id));
		const retentionCandidates = sourceItems.filter(
			(item) =>
				(item.kind === "user" ||
					item.kind === "pinned-note" ||
					(item.groupId !== undefined && tailGroups.has(item.groupId))) &&
				item.nodeRole !== "checkpoint" &&
				!eligibleIds.has(item.id),
		);
		const inheritedTail = baseCheckpoint
			? (validCheckpoint(baseCheckpoint)?.retainedTail ?? [])
			: [];
		const tailBudget = Math.min(
			20_000,
			Math.floor((options.budget ?? Number.MAX_SAFE_INTEGER) * 0.25),
		);
		const episodeTail = episodeConclusionPayloads(
			items,
			this.episodes(sessionId).map((episode) =>
				episode.state === "completed"
					? { ...episode, state: "archived" }
					: episode,
			),
		);
		const groups = new Map<string, ContextItem[]>();
		for (const item of retentionCandidates) {
			const key = item.groupId ?? item.id;
			groups.set(key, [...(groups.get(key) ?? []), item]);
		}
		const stableKey = retentionCandidates.find(
			(item) => item.kind === "user" || item.kind === "pinned-note",
		);
		const stableGroupKey = stableKey?.groupId ?? stableKey?.id;
		const recentKeys = [...groups.keys()]
			.toReversed()
			.filter((key) => key !== stableGroupKey);
		const retainedIds = new Set<string>();
		let tailTokens = 0;
		const retainGroup = (key: string): void => {
			const group = groups.get(key) ?? [];
			const cost = group.reduce((sum, item) => {
				const payload = projectedPayload(item);
				return sum + (payload === undefined ? 0 : tokenCostOf(payload));
			}, 0);
			if (tailTokens + cost > tailBudget) return;
			for (const item of group) retainedIds.add(item.id);
			tailTokens += cost;
		};
		if (stableGroupKey) retainGroup(stableGroupKey);
		const anchorTail = boundedAnchorTail(
			inheritedTail,
			episodeTail,
			tailBudget - tailTokens,
		);
		tailTokens += anchorTail.tokens;
		for (const key of recentKeys) retainGroup(key);
		const retainedItems = sourceItems.filter((item) =>
			retainedIds.has(item.id),
		);
		const boundedTail = [
			...anchorTail.messages,
			...retainedItems.flatMap((item) => {
				const payload = projectedPayload(item);
				return payload === undefined ? [] : [payload];
			}),
		];
		const omittedItems = sourceItems.filter(
			(item) => !eligibleIds.has(item.id) && !retainedIds.has(item.id),
		);
		const omittedDigest = structuredHash(
			omittedItems.map(({ id, contentHash }) => ({ id, contentHash })),
		);
		this.appendCheckpoint(
			sessionId,
			"main",
			{ kind: "condensation", memory: merged },
			boundedTail,
			{
				condensedCount: eligible.length,
				retainedCount: retainedItems.length,
				omittedDigest,
			},
		);
		const tokensAfter =
			(options.overheadTokens ?? 0) +
			projectedPathPayloads(
				this.store.contextPath(sessionId, "main"),
				this.episodes(sessionId),
			).reduce<number>((sum, payload) => sum + tokenCostOf(payload), 0);
		this.sink?.({
			type: "context.assembly.completed",
			timestamp: new Date().toISOString(),
			sessionId,
			...(options.taskId ? { taskId: options.taskId } : {}),
			...(options.turnId === undefined ? {} : { turnId: options.turnId }),
			trigger: "explicit",
			scope: options.taskId ? "task" : "session",
			tokensBefore,
			tokensAfter,
			budget: options.budget ?? tokensAfter,
			target: options.target ?? tokensAfter,
			underPressure: false,
			evictedItems: eligible.length,
			archivedEpisodes: 0,
			liveTokens: tokensAfter,
			historyTokens: items.reduce((sum, item) => sum + item.tokenCost, 0),
		});
		this.sink?.({
			type: "context.compaction.completed",
			timestamp: new Date().toISOString(),
			sessionId,
			...(options.taskId ? { taskId: options.taskId } : {}),
			...(options.turnId === undefined ? {} : { turnId: options.turnId }),
			trigger: "explicit",
			evictedItems: eligible.length,
			archivedEpisodes: 0,
			tokensBefore,
			tokensAfter,
		});
		return {
			noOp: false,
			assemblyId,
			milestone: next.milestone,
			archivedItems: eligible.length,
			archivedEpisodes: 0,
			tokensBefore,
			tokensAfter,
			memoryTokens,
		};
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
		const text =
			item?.kind === "observation" && typeof item.payload === "string"
				? item.payload
				: item?.kind === "user" &&
					  item.source?.observationId === item.id &&
					  typeof userText(item.payload) === "string"
					? userText(item.payload)
					: undefined;
		if (
			!item ||
			item.sessionId !== sessionId ||
			item.source?.observationId !== observationId ||
			text === undefined
		)
			throw new Error("Observation not found");
		return {
			observationId,
			text: text.slice(offset, offset + limit),
			offset,
			limit,
			totalLength: text.length,
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
		const scopeId = options.taskId ?? sessionId;
		const assemblyId =
			(this.assemblyIds.set(scopeId, (this.assemblyIds.get(scopeId) ?? 0) + 1),
			this.assemblyIds.get(scopeId)!);
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
		if (underPressure && state.estimatedTokens > options.budget) {
			this.sink?.({
				type: "context.assembly.failed",
				timestamp: new Date().toISOString(),
				sessionId,
				...(options.taskId ? { taskId: options.taskId } : {}),
				...(options.turnId === undefined ? {} : { turnId: options.turnId }),
				assemblyId,
				budget: options.budget,
				tokensBefore,
				tokensAfter: state.estimatedTokens,
				error: "budget",
			});
			throw new ContextBudgetError(state.estimatedTokens, options.budget);
		}
		/**
		 * After the archiving pass, never before it: a note about scarce budget
		 * that competed for that same budget could be the weight that pushes an
		 * assembly past its target. It reaches the model on the next assembly,
		 * which a turn under pressure always performs.
		 */
		if (underPressure)
			this.notePressure(sessionId, state.estimatedTokens, options.budget);
		const pressureStreak = underPressure
			? (this.pressureStreak.get(scopeId) ?? 0) + 1
			: 0;
		if (underPressure) this.pressureStreak.set(scopeId, pressureStreak);
		else this.pressureStreak.delete(scopeId);
		if (underPressure) this.pressured.add(scopeId);
		this.sink?.({
			type: "context.assembly.completed",
			timestamp: new Date().toISOString(),
			sessionId,
			...(options.taskId ? { taskId: options.taskId } : {}),
			...(options.turnId === undefined ? {} : { turnId: options.turnId }),
			assemblyId,
			trigger: options.trigger ?? "initial",
			scope: options.taskId ? "task" : "session",
			tokensBefore,
			tokensAfter: state.estimatedTokens,
			budget: options.budget,
			target: options.target,
			underPressure,
			pressureStreak,
			agentContinued: this.pressured.has(`${scopeId}:continued`),
			evictedItems: evictedIds.length,
			archivedEpisodes: archivedEpisodeIds.length,
			liveTokens: state.estimatedTokens,
			historyTokens: this.store
				.contextItems(sessionId)
				.reduce((sum, item) => sum + item.tokenCost, 0),
			rollingSummaryChanged: evictedIds.some(
				(id) =>
					this.store.contextItems(sessionId).find((item) => item.id === id)
						?.reason === ROLLING_SUMMARY_REASON,
			),
		});
		if (evictedIds.length)
			this.sink?.({
				type: "context.compaction.completed",
				timestamp: new Date().toISOString(),
				sessionId,
				...(options.taskId ? { taskId: options.taskId } : {}),
				...(options.turnId === undefined ? {} : { turnId: options.turnId }),
				assemblyId,
				trigger: "automatic",
				evictedItems: evictedIds.length,
			});
		return {
			payloads: [...projectedPayloads(state.items, state.episodes)],
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
		const items = this.store.contextPath(sessionId, "main");
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
			this.store.contextPath(sessionId, "main").filter(inWindow),
			options,
			compaction.evictedIds,
		);
		const items = this.store.contextPath(sessionId, "main").filter(inWindow);
		const taskEpisodes = this.episodes(sessionId).filter((episode) =>
			items.some(
				(item) =>
					item.episodeId === episode.id &&
					item.sequence > options.taskStartSequence,
			),
		);
		const estimatedTokens = estimatedCost(
			items,
			options.overheadTokens,
			taskEpisodes,
		);
		if (estimatedTokens > options.budget)
			throw new ContextBudgetError(estimatedTokens, options.budget);
		return {
			payloads: projectedPayloads(items, taskEpisodes),
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
			estimatedTokens: projectedEstimatedCost(
				this.store.contextPath(sessionId, "main"),
				overheadTokens,
				episodes,
			),
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

function projectedEstimatedCost(
	path: ContextItem[],
	overheadTokens: number,
	episodes: ContextEpisode[],
): number {
	return (
		overheadTokens +
		projectedPathPayloads(path, episodes).reduce<number>(
			(sum, payload) => sum + tokenCostOf(payload),
			0,
		)
	);
}

function boundedAnchorTail(
	inherited: readonly unknown[],
	conclusions: readonly unknown[],
	budget: number,
): { messages: unknown[]; tokens: number } {
	const selectedInherited = new Set<number>();
	const selectedConclusions = new Set<number>();
	let tokens = 0;
	const admit = (value: unknown): boolean => {
		const cost = tokenCostOf(value);
		if (tokens + cost > budget) return false;
		tokens += cost;
		return true;
	};
	for (let index = 0; index < conclusions.length; index++)
		if (admit(conclusions[index])) selectedConclusions.add(index);
	if (inherited.length && admit(inherited[0])) selectedInherited.add(0);
	for (let index = inherited.length - 1; index > 0; index--)
		if (admit(inherited[index])) selectedInherited.add(index);
	return {
		messages: [
			...inherited.filter((_, index) => selectedInherited.has(index)),
			...conclusions.filter((_, index) => selectedConclusions.has(index)),
		],
		tokens,
	};
}

function tokenCostOf(value: unknown): number {
	return Number(computeTokenCost(value as never));
}

function projectedPendingPayload(input: RecordInput): unknown {
	return input.projection === "reference" || input.projection === "compact"
		? (input.compactPayload ?? input.payload)
		: input.payload;
}

function projectedPendingCost(input: RecordInput): number {
	return input.projection === "reference" || input.projection === "compact"
		? (input.compactTokenCost ?? tokenCostOf(projectedPendingPayload(input)))
		: input.tokenCost;
}

function referencedUserProjection(
	payload: unknown,
	id: string,
	maxTokens: number,
): {
	payload: { role: "user"; content: string };
	previewedRanges: SourceRange[];
} {
	const text = userText(payload);
	const maxChars = Math.max(0, Math.floor(maxTokens * 4));
	let previewChars = Math.min(text.length, maxChars);
	for (;;) {
		const headLength = Math.ceil(previewChars / 2);
		const tailLength = previewChars - headLength;
		const overlaps = headLength + tailLength >= text.length;
		const ranges: SourceRange[] = overlaps
			? previewChars
				? [[0, text.length]]
				: []
			: [
					[0, headLength],
					[text.length - tailLength, text.length],
				];
		const unread = overlaps
			? []
			: [[headLength, text.length - tailLength] as SourceRange];
		const content = [
			"[authoritative user source; inspect according to task coverage]",
			`authoritative_source: observation://${id}`,
			`characters: ${text.length}`,
			"previewed_ranges:",
			...ranges.map(([start, end]) => `  - [${start}, ${end})`),
			"unread_ranges:",
			...unread.map(([start, end]) => `  - [${start}, ${end})`),
			...(previewChars
				? [
						"",
						text.slice(0, headLength),
						...(overlaps ? [] : [text.slice(-tailLength)]),
					]
				: []),
		].join("\n");
		const result = { role: "user" as const, content };
		if (tokenCostOf(result) <= maxTokens || previewChars === 0)
			return { payload: result, previewedRanges: ranges };
		previewChars = Math.max(
			0,
			previewChars - (tokenCostOf(result) - maxTokens) * 4,
		);
	}
}

function boundedText(value: unknown, limit: number): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return (text ?? "").slice(0, limit);
}

function projectedPayloads(
	items: ContextItem[],
	episodes: ContextEpisode[] = [],
): NonNullable<ReturnType<typeof projectedPayload>>[] {
	if (items.some((item) => item.nodeRole === "checkpoint"))
		return projectedPathPayloads(items, episodes) as NonNullable<
			ReturnType<typeof projectedPayload>
		>[];
	const ordered = items.toSorted(
		(a, b) => assemblyRank(a) - assemblyRank(b) || a.sequence - b.sequence,
	);
	return [
		...ordered
			.filter((item) => assemblyRank(item) === 0)
			.flatMap(projectedItemPayload),
		...episodeConclusionPayloads(items, episodes),
		...ordered
			.filter((item) => assemblyRank(item) === 1)
			.flatMap(projectedItemPayload),
		...ordered
			.filter((item) => assemblyRank(item) === 2)
			.flatMap(projectedItemPayload),
	];
}

function projectedItemPayload(
	item: ContextItem,
): NonNullable<ReturnType<typeof projectedPayload>>[] {
	if (item.kind === "system" || item.kind === "observation") return [];
	const value = projectedPayload(item);
	return value == null ? [] : [value];
}

function assemblyRank(item: ContextItem): number {
	return item.kind === "system" ||
		item.kind === "user" ||
		item.kind === "pinned-note"
		? 0
		: item.kind === "long-term-memory"
			? 1
			: 2;
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
