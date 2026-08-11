import { tokenCost } from "../token-cost";
import type { ContextEpisode, ContextItem, ContextProjection } from "./types";

export function episodeConclusionPayloads(
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

export function estimatedCost(
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

export function projectedPayload(item: ContextItem): unknown {
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

export function assistantText(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const content = (payload as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((item) =>
			item &&
			typeof item === "object" &&
			(item as { type?: unknown }).type === "text" &&
			typeof (item as { text?: unknown }).text === "string"
				? [(item as { text: string }).text]
				: [],
		)
		.join("");
}

export function userVisibleAssistant(payload: unknown): unknown | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const message = structuredClone(payload) as {
		role?: unknown;
		content?: unknown;
	};
	if (message.role !== "assistant" || !Array.isArray(message.content))
		return undefined;
	const content = message.content.filter(
		(item) =>
			item &&
			typeof item === "object" &&
			(item as { type?: unknown }).type === "text" &&
			typeof (item as { text?: unknown }).text === "string",
	);
	message.content = content;
	return content.length ? message : undefined;
}

export function projectionCost(
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

export function evictionCandidates(
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

export function evictionGroup(
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

export function archivedProjection(item: ContextItem): ContextProjection {
	return item.kind === "assistant"
		? "omitted"
		: item.compactPayload === undefined
			? "reference"
			: "compact";
}
export function currentCost(items: ContextItem[]): number {
	return items.reduce((total, item) => total + projectionCost(item), 0);
}
export function archivedCost(items: ContextItem[]): number {
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
