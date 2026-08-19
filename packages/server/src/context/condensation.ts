import { isAbsolute } from "node:path";

import { tokenCost } from "../token-cost";
import { projectionCost } from "./projection";
import { parseObservationUri } from "./recall";
import type { ContextItem } from "./types";

export type CondensationInput = {
	milestone: string;
	completedWork: string[];
	strategies: Array<{ approach: string; outcome: string }>;
	environmentChanges: string[];
	constraints: string[];
	openQuestions: string[];
	references: string[];
};

export type CondensationMemory = CondensationInput;

export type CondensationSelectionOptions = {
	recentGroups?: number;
	currentTaskStartSequence?: number;
	predecessorTerminalIds?: readonly string[];
};

export const MEMORY_MAX_TOKENS = 2_000;
export const MEMORY_REASON = "agent context condensation";
const MEMORY_MARKER = "<harnez-long-term-memory>";

export function validateCondensationInput(input: unknown): CondensationInput {
	if (!input || typeof input !== "object")
		throw new Error("Invalid condensation input");
	const value = input as Record<string, unknown>;
	const milestone = stringValue(value["milestone"], "milestone", 200);
	const completedWork = stringArray(value["completedWork"], "completedWork");
	const strategies = value["strategies"];
	if (!Array.isArray(strategies) || strategies.length > 20)
		throw new Error("strategies must contain at most 20 entries");
	const normalizedStrategies = strategies.map((entry, index) => {
		if (!entry || typeof entry !== "object")
			throw new Error(`strategies[${index}] is invalid`);
		const record = entry as Record<string, unknown>;
		return {
			approach: stringValue(
				record["approach"],
				`strategies[${index}].approach`,
			),
			outcome: stringValue(record["outcome"], `strategies[${index}].outcome`),
		};
	});
	const environmentChanges = stringArray(
		value["environmentChanges"],
		"environmentChanges",
	);
	const constraints = stringArray(value["constraints"], "constraints");
	const openQuestions = stringArray(value["openQuestions"], "openQuestions");
	const references = stringArray(value["references"], "references");
	for (const reference of references) {
		if (isAbsolute(reference))
			throw new Error("Absolute references are not allowed");
		if (reference.startsWith("observation://")) parseObservationUri(reference);
		else if (reference.includes("://")) throw new Error("Invalid reference");
	}
	if (
		![
			completedWork,
			normalizedStrategies,
			environmentChanges,
			constraints,
			openQuestions,
			references,
		].some((items) => items.length)
	)
		throw new Error("At least one condensation entry is required");
	const result = {
		milestone,
		completedWork,
		strategies: normalizedStrategies,
		environmentChanges,
		constraints,
		openQuestions,
		references,
	};
	if (memoryTokenCost(result) > MEMORY_MAX_TOKENS)
		throw new Error("Condensation memory exceeds 2,000 tokens");
	return result;
}

function stringValue(value: unknown, field: string, maxLength = 1_000): string {
	if (typeof value !== "string") throw new Error(`${field} must be a string`);
	const result = value.trim();
	if (!result || result.length > maxLength)
		throw new Error(`${field} must be 1-${maxLength} characters`);
	return result;
}

function stringArray(value: unknown, field: string): string[] {
	if (!Array.isArray(value) || value.length > 20)
		throw new Error(`${field} must contain at most 20 entries`);
	return value.map((entry, index) => stringValue(entry, `${field}[${index}]`));
}

export function memoryTokenCost(memory: CondensationMemory): number {
	return tokenCost(memoryPayload(memory));
}

export function memoryPayload(memory: CondensationMemory): {
	role: "user";
	content: string;
} {
	return {
		role: "user",
		content: `${MEMORY_MARKER}\n${JSON.stringify(memory)}\n</harnez-long-term-memory>`,
	};
}

function isLongTermMemory(item: ContextItem): boolean {
	return item.kind === "long-term-memory" || item.reason === MEMORY_REASON;
}

export function selectCondensationItems(
	items: readonly ContextItem[],
	options: CondensationSelectionOptions = {},
): ContextItem[] {
	const recentGroups = options.recentGroups ?? 4;
	const terminals = new Set(options.predecessorTerminalIds ?? []);
	const taskStart =
		options.currentTaskStartSequence ?? Number.POSITIVE_INFINITY;
	const activeEpisodes = new Set(
		items
			.filter((item) => item.lifecycle === "active")
			.flatMap((item) => (item.episodeId ? [item.episodeId] : [])),
	);
	const predecessorGroups = new Set(
		items
			.filter((item) => terminals.has(item.id) && item.groupId)
			.flatMap((item) => (item.groupId ? [item.groupId] : [])),
	);
	const groups = new Map<string, number>();
	for (const item of items)
		if (
			item.sequence < taskStart &&
			!activeEpisodes.has(item.episodeId ?? "") &&
			item.groupId &&
			(item.kind === "assistant" || item.kind === "tool-result") &&
			item.lifecycle === "retained"
		)
			groups.set(
				item.groupId,
				Math.max(groups.get(item.groupId) ?? 0, item.sequence),
			);
	const protectedGroups = new Set(
		[...groups.entries()]
			.toSorted((a, b) => b[1] - a[1])
			.slice(0, recentGroups)
			.map(([id]) => id),
	);
	return items.filter((item) => {
		if (
			isLongTermMemory(item) ||
			item.kind === "observation" ||
			item.kind === "system" ||
			item.kind === "user" ||
			item.kind === "pinned-note"
		)
			return false;
		if (item.lifecycle !== "retained") return false;
		if (
			item.sequence >= taskStart ||
			terminals.has(item.id) ||
			(item.groupId !== undefined && predecessorGroups.has(item.groupId)) ||
			(item.episodeId && activeEpisodes.has(item.episodeId))
		)
			return false;
		if (item.groupId && protectedGroups.has(item.groupId)) return false;
		return (
			item.kind === "assistant" ||
			item.kind === "tool-result" ||
			!!item.episodeId
		);
	});
}

export function mergeCondensationMemory(
	prior: CondensationMemory | undefined,
	next: CondensationInput,
): CondensationMemory {
	return {
		milestone: next.milestone,
		completedWork: dedupe([
			...(prior?.completedWork ?? []),
			...next.completedWork,
		]),
		strategies: dedupe([...(prior?.strategies ?? []), ...next.strategies]),
		environmentChanges: dedupe([
			...(prior?.environmentChanges ?? []),
			...next.environmentChanges,
		]),
		constraints: dedupe([...(prior?.constraints ?? []), ...next.constraints]),
		openQuestions: dedupe([
			...(prior?.openQuestions ?? []),
			...next.openQuestions,
		]),
		references: dedupe([...(prior?.references ?? []), ...next.references]),
	};
}

function dedupe<T>(values: T[]): T[] {
	const seen = new Set<string>();
	const result: T[] = [];
	for (const value of values.toReversed()) {
		const key = JSON.stringify(value);
		if (seen.has(key)) continue;
		seen.add(key);
		result.unshift(value);
	}
	return result.slice(-20);
}

export function parseCondensationMemory(
	payload: unknown,
): CondensationMemory | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const representation = (payload as { representation?: unknown }).representation;
	if (representation && typeof representation === "object" && (representation as { kind?: unknown }).kind === "condensation") {
		try {
			return validateCondensationInput((representation as { memory?: unknown }).memory);
		} catch {
			return undefined;
		}
	}
	const content = (payload as { content?: unknown }).content;
	if (typeof content !== "string" || !content.startsWith(`${MEMORY_MARKER}\n`))
		return undefined;
	const json = content.slice(
		MEMORY_MARKER.length + 1,
		content.lastIndexOf("\n</harnez-long-term-memory>"),
	);
	try {
		return validateCondensationInput(JSON.parse(json));
	} catch {
		return undefined;
	}
}

export function projectedSavings(
	items: readonly ContextItem[],
	replacementTokens: number,
): number {
	return (
		items.reduce((sum, item) => sum + projectionCost(item), 0) -
		replacementTokens
	);
}
