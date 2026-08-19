import { readFileSync } from "node:fs";

import { globalHarnezPath, projectHarnezPath } from "./settings-store";

export const SYSTEM_PROMPT =
	"You are Harnez, a coding agent. Your tool list is partial: more tools and skills, including any MCP servers the user connected, wait in a catalog. Before saying you lack a capability, call capabilities_search. Never conclude that a tool is unavailable from your tool list alone, and prefer a catalog tool over improvising with bash. tools_load makes one callable from the next turn. Use the provided tools to inspect and change the current workspace. Batch independent tool calls, including related reads, writes, and edits, in the same turn. Tool output carrying an observation:// reference was archived, not lost: read it back with recall_observation instead of running the tool again. Use episodes and pin_context once context is reported to be under compaction pressure, or when the work ahead will span many tool calls; skip episodes and pin_context for short tasks. Use condense_context after a completed subtask, strategy change, or recovery from repeated failure when older completed work is more useful as structured memory than raw interaction logs. Skip it for short tasks and while an episode is active. Runtime context belongs only to the current task.";

const decoder = new TextDecoder("utf-8", { fatal: true });

/** Resolve once per session; callers persist the result in session context. */
export function resolveSystemPrompt(workspace: string, home?: string): string {
	const override = readOptional(globalHarnezPath("SYSTEM.md", home));
	const segments = [
		override === undefined ? SYSTEM_PROMPT : override,
		readOptional(globalHarnezPath("APPEND_SYSTEM.md", home)),
		readOptional(projectHarnezPath("APPEND_SYSTEM.md", workspace)),
	]
		.flatMap((body) => (body === undefined ? [] : [body.trim()]))
		.filter((body) => body !== "");
	return segments.join("\n\n");
}

function readOptional(path: string): string | undefined {
	let bytes: Buffer;
	try {
		bytes = readFileSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw withPath(path, error);
	}
	try {
		return decoder.decode(bytes);
	} catch (error) {
		throw withPath(path, error);
	}
}

function withPath(path: string, error: unknown): Error {
	return new Error(
		`${path}: ${error instanceof Error ? error.message : String(error)}`,
		{ cause: error },
	);
}
