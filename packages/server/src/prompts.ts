import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type PromptTemplate = {
	name: string;
	description: string;
	body: string;
	path: string;
};
type PromptDiagnostic = {
	path: string;
	state: "invalid" | "unreadable";
	error: string;
};
export type PromptScan = {
	templates: PromptTemplate[];
	diagnostics: PromptDiagnostic[];
};

const SUMMARY_LIMIT = 120;

/** Narrow a caught value to a Node.js error that carries a `code` property. */
function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		typeof (error as NodeJS.ErrnoException).code === "string"
	);
}

/** `.harness` is the pre-rename spelling, still read so older checkouts keep working. */
function promptRoots(workspace: string, home = homedir()): string[] {
	return [
		join(workspace, ".harnez/prompts"),
		join(workspace, ".harness/prompts"),
		join(workspace, ".agents/prompts"),
		join(home, ".harnez/prompts"),
		join(home, ".harness/prompts"),
		join(home, ".agents/prompts"),
	];
}

/**
 * Reads every `<root>/<name>.md`. Templates are small and always expand whole,
 * so bodies are kept with the metadata instead of being reread on invocation.
 * The first valid file for a name wins; later duplicates are ignored.
 */
export async function scanPrompts(
	workspace: string,
	home = homedir(),
): Promise<PromptScan> {
	const result: PromptScan = { templates: [], diagnostics: [] };
	const seen = new Set<string>();
	for (const root of promptRoots(workspace, home)) {
		let entries: Dirent[];
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch (error) {
			// An absent root is the normal case — few checkouts define all six.
			// Anything else (permissions, I/O) is reported and the scan goes on.
			if (!isErrnoException(error) || error.code !== "ENOENT")
				result.diagnostics.push({
					path: root,
					state: "unreadable",
					error: error instanceof Error ? error.message : String(error),
				});
			continue;
		}
		for (const entry of entries
			.filter(
				(candidate) => candidate.isFile() && candidate.name.endsWith(".md"),
			)
			.toSorted((a, b) => a.name.localeCompare(b.name))) {
			const path = join(root, entry.name);
			try {
				const template = parsePromptBuffer(
					await readFile(path),
					entry.name.slice(0, -".md".length),
					path,
				);
				if (seen.has(template.name)) continue;
				seen.add(template.name);
				result.templates.push(template);
			} catch (error) {
				result.diagnostics.push({
					path,
					state: "invalid",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	result.templates.sort((a, b) => a.name.localeCompare(b.name));
	return result;
}

/**
 * Expands `/<name>` into its template body. Only the first token of a prompt is
 * an invocation, so slash names later in the text stay available to skills.
 * Trailing text is appended to the body as the caller's own instruction.
 */
export function expandPrompt(
	text: string,
	templates: readonly PromptTemplate[],
): { text: string; template?: PromptTemplate } {
	const match = text.trim().match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
	const template = templates.find(
		(candidate) => candidate.name === (match?.[1] ?? ""),
	);
	if (!template) return { text };
	const trailing = match?.[2]?.trim();
	return {
		text: trailing ? `${template.body}\n\n${trailing}` : template.body,
		template,
	};
}

function parsePromptBuffer(
	buffer: Uint8Array,
	stem: string,
	path: string,
): PromptTemplate {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	const fields = match?.[1] ? promptFields(match[1]) : {};
	const body = (match ? text.slice(match[0].length) : text).trim();
	if (!body) throw new Error("prompt template body is empty");
	const declared = fields["name"];
	if (declared !== undefined && typeof declared !== "string")
		throw new Error("prompt name must be text");
	const name = (declared ?? stem).trim();
	if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
		throw new Error(
			"prompt name must use lowercase letters, digits, and hyphens",
		);
	const description = fields["description"];
	if (
		description !== undefined &&
		(typeof description !== "string" ||
			!description.trim() ||
			description.length > 2_000)
	)
		throw new Error(
			"prompt description must be text limited to 2000 characters",
		);
	return {
		name,
		description: description?.trim() ?? summarize(body),
		body,
		path,
	};
}

function promptFields(frontmatter: string): Record<string, unknown> {
	const parsed = Bun.YAML.parse(frontmatter);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("invalid prompt frontmatter");
	return parsed as Record<string, unknown>;
}

/** Templates without a description are listed by their first line of text. */
function summarize(body: string): string {
	const line = (body.split(/\r?\n/).find((candidate) => candidate.trim()) ?? "")
		.replace(/^#+\s*/, "")
		.trim();
	if (!line) return "Prompt template";
	return line.length > SUMMARY_LIMIT
		? `${line.slice(0, SUMMARY_LIMIT - 1).trimEnd()}…`
		: line;
}
