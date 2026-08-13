export type SlashCommandKind = "command" | "skill" | "prompt";

export function slashCommandPattern(): RegExp {
	return /(^|\s)\/([a-z0-9-]+)(?=$|\s|[.,!?;:])/g;
}

/**
 * Mirrors what the server expands at a given offset in a prompt: a skill is
 * activated wherever its name appears, a prompt template only as the first
 * token. Everything else is plain text by the time the prompt is submitted.
 */
export function expandsAt(
	kind: SlashCommandKind | undefined,
	start: number,
): boolean {
	return kind === "skill" || (kind === "prompt" && start === 0);
}
