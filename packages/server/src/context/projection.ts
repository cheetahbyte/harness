import { tokenCost } from "../token-cost";
import { memoryPayload, validateCondensationInput } from "./condensation";
import type {
	ContextCheckpointPayload,
	ContextEpisode,
	ContextItem,
	ContextProjection,
} from "./types";

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
	if (item.nodeRole === "checkpoint") {
		const checkpoint = validCheckpoint(item);
		return checkpoint ? checkpointRepresentation(checkpoint) : undefined;
	}
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

/** A checkpoint replaces its complete parent prefix in the provider view. */
export function projectedPathPayloads(
	path: readonly ContextItem[],
	episodes: ContextEpisode[] = [],
): unknown[] {
	const valid = path
		.map((item, index) => ({ item, index, checkpoint: validCheckpoint(item) }))
		.filter(
			(
				entry,
			): entry is {
				item: ContextItem;
				index: number;
				checkpoint: ContextCheckpointPayload;
			} => entry.checkpoint !== undefined,
		);
	const newest = valid.at(-1);
	const values: unknown[] = [];
	if (newest) {
		const representation = checkpointRepresentation(newest.checkpoint);
		if (representation !== undefined) values.push(representation);
		values.push(...newest.checkpoint.retainedTail);
	}
	if (!newest) values.push(...episodeConclusionPayloads([...path], episodes));
	const visible = newest ? path.slice(newest.index + 1) : path;
	for (const item of visible) {
		if (item.nodeRole === "checkpoint") continue;
		const value = projectedItemPayload(item);
		if (value !== undefined) values.push(value);
	}
	return values;
}

export function validCheckpoint(
	item: ContextItem,
): ContextCheckpointPayload | undefined {
	if (item.nodeRole !== "checkpoint" || item.kind !== "long-term-memory")
		return undefined;
	const payload = item.payload as Partial<ContextCheckpointPayload>;
	if (
		!payload ||
		payload.schemaVersion !== 1 ||
		typeof payload.sourceDigest !== "string" ||
		typeof payload.policyVersion !== "number" ||
		typeof payload.baseRevision !== "number" ||
		typeof payload.omittedDigest !== "string" ||
		!payload.coverage ||
		typeof payload.coverage.sourceCount !== "number" ||
		typeof payload.coverage.condensedCount !== "number" ||
		typeof payload.coverage.retainedCount !== "number" ||
		typeof payload.coverage.omittedCount !== "number" ||
		typeof payload.coverage.omittedDigest !== "string" ||
		!Array.isArray(payload.coverage.references) ||
		payload.coverage.references.some((ref) => typeof ref !== "string") ||
		[
			payload.coverage.sourceCount,
			payload.coverage.condensedCount,
			payload.coverage.retainedCount,
			payload.coverage.omittedCount,
		].some((count) => !Number.isInteger(count) || count < 0) ||
		payload.coverage.sourceCount !==
			payload.coverage.condensedCount +
				payload.coverage.retainedCount +
				payload.coverage.omittedCount ||
		!Array.isArray(payload.retainedTail) ||
		!payload.representation ||
		(item.sourceDigest !== undefined &&
			item.sourceDigest !== payload.sourceDigest) ||
		(item.policyVersion !== undefined &&
			item.policyVersion !== payload.policyVersion) ||
		(payload.coveredThroughId !== undefined &&
			payload.coveredThroughId !== item.parentId)
	)
		return undefined;
	if (payload.representation.kind === "condensation") {
		try {
			validateCondensationInput(payload.representation.memory);
		} catch {
			return undefined;
		}
	} else if (
		payload.representation.kind !== "fallback" ||
		typeof payload.representation.summary !== "string" ||
		!Array.isArray(payload.representation.references) ||
		payload.representation.references.some((ref) => typeof ref !== "string")
	)
		return undefined;
	return payload as ContextCheckpointPayload;
}

function checkpointRepresentation(payload: ContextCheckpointPayload): unknown {
	if (payload.representation.kind === "condensation")
		return memoryPayload(
			payload.representation.memory as Parameters<typeof memoryPayload>[0],
		);
	const { summary, references } = payload.representation;
	if (!summary && !references.length) return undefined;
	return {
		role: "user",
		content: [summary, ...references.map((ref) => `Reference: ${ref}`)]
			.filter(Boolean)
			.join("\n"),
	};
}

function projectedItemPayload(item: ContextItem): unknown {
	if (item.kind === "system" || item.kind === "observation") return undefined;
	return projectedPayload(item);
}

export function assistantText(payload: unknown): string {
	if (!payload || typeof payload !== "object") return "";
	const content = (payload as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isTextItem)
		.map((item) => item.text)
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
	const content = message.content.filter(isTextItem);
	message.content = content;
	return content.length ? message : undefined;
}

export function projectionCost(
	item: ContextItem,
	projection: ContextProjection = item.projection,
): number {
	if (projection === "full") return item.tokenCost;
	if (projection === "omitted") return 0;
	if (item.compactPayload === undefined)
		return projection === "reference" ? 0 : item.tokenCost;
	return item.compactTokenCost ?? item.tokenCost;
}

function isTextItem(item: unknown): item is { type: "text"; text: string } {
	return (
		!!item &&
		typeof item === "object" &&
		(item as { type?: unknown }).type === "text" &&
		typeof (item as { text?: unknown }).text === "string"
	);
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
		.toSorted(
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
	return { early: 0, normal: 1, late: 2 }[
		item.source?.evictionPriority ?? "normal"
	];
}
