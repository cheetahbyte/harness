import type { ObservationRecallInput } from "./types";

export const DEFAULT_OBSERVATION_RECALL_LIMIT = 16 * 1024;
export const MAX_OBSERVATION_RECALL_LIMIT = 64 * 1024;

export function parseObservationUri(uri: string): ObservationRecallInput {
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

export function validateRecallBounds(offset: number, limit: number): void {
	if (!Number.isSafeInteger(offset) || offset < 0)
		throw new Error("Invalid observation offset");
	if (
		!Number.isSafeInteger(limit) ||
		limit < 1 ||
		limit > MAX_OBSERVATION_RECALL_LIMIT
	)
		throw new Error("Invalid observation limit");
}

function integerParameter(value: string | null, name: string): number {
	if (value === null || !/^(0|[1-9]\d*)$/.test(value))
		throw new Error(`Invalid observation ${name}`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed))
		throw new Error(`Invalid observation ${name}`);
	return parsed;
}
