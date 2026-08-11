import type { ContextEpisode, ContextEpisodeEvent, ContextItem } from "./types";

export type EpisodeSnapshot = { episode: ContextEpisode; malformed: boolean };

export function replayEpisodes(
	events: ContextEpisodeEvent[],
): EpisodeSnapshot[] {
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

export function episodeStates(
	items: ContextItem[],
	snapshots: EpisodeSnapshot[],
): ContextEpisode[] {
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
		const episodeItems = items.filter((item) => item.episodeId === episode.id);
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

function isEpisodeItemEvictable(item: ContextItem): boolean {
	return item.kind !== "user" && item.lifecycle !== "pinned";
}
export function structuralEvictionCandidates(
	episodes: ContextEpisode[],
): ContextEpisode[] {
	const actions = episodes.filter(
		(episode) => episode.kind === "action" && episode.state === "completed",
	);
	return actions.length
		? actions
		: episodes.filter(
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
export function structuralEvictionItems(
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
