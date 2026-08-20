import {
	BoxRenderable,
	bold,
	type CliRenderer,
	fg,
	ScrollBoxRenderable,
	StyledText,
	TextRenderable,
	t,
} from "@opentui/core";

import {
	expandsAt,
	slashCommandPattern,
} from "../../../shared/src/slash-command";
import { isMcpTool, mcpToolName, type TranscriptEntry } from "../store";
import {
	ACCENT,
	DIM,
	ERROR,
	TEXT,
	USER_BACKGROUND,
	USER_PROMPT,
	USER_PROMPT_PENDING,
	USER_TEXT,
	WARNING,
} from "./theme";

type DisplayEntry =
	| TranscriptEntry
	| { kind: "tool-group"; tools: TranscriptEntry[] };

export class TranscriptView {
	readonly root: ScrollBoxRenderable;
	private skillNames = new Set<string>();
	private promptNames = new Set<string>();
	private readonly renderedEntries: {
		row: BoxRenderable;
		text: TextRenderable;
		kind: DisplayEntry["kind"];
		detail?: TextRenderable;
		gutter?: TextRenderable;
	}[] = [];
	private disableThinkingBlocks = false;

	constructor(private readonly renderer: CliRenderer) {
		this.root = new ScrollBoxRenderable(renderer, {
			width: "100%",
			flexGrow: 1,
			flexBasis: 0,
			stickyScroll: true,
			stickyStart: "bottom",
			viewportCulling: true,
			paddingRight: 1,
		});
	}

	setSkills(skillNames: readonly string[]) {
		this.skillNames = new Set(skillNames);
	}

	setPrompts(promptNames: readonly string[]) {
		this.promptNames = new Set(promptNames);
	}

	setDisableThinkingBlocks(disabled: boolean) {
		this.disableThinkingBlocks = disabled;
		for (const entry of this.renderedEntries)
			if (entry.kind === "reasoning") entry.row.visible = !disabled;
	}

	update(entries: TranscriptEntry[]) {
		const displayEntries = groupToolCalls(entries);
		if (displayEntries.length < this.renderedEntries.length) {
			for (const { row } of this.renderedEntries) this.root.remove(row);
			this.renderedEntries.length = 0;
		}
		for (
			let index = this.renderedEntries.length;
			index < displayEntries.length;
			index++
		) {
			const entry = displayEntries[index];
			if (!entry) continue;
			const toolCall = entry.kind === "tool-group";
			const text = new TextRenderable(this.renderer, {
				content: toolCall
					? formatToolTitle(entry.tools)
					: formatEntry(entry, this.skillNames, this.promptNames),
				fg: toolCall ? ACCENT : entryColor(entry),
				flexGrow: 1,
			});
			const row = new BoxRenderable(this.renderer, {
				width: "100%",
				marginBottom: 1,
				flexDirection: toolCall ? "column" : "row",
				...(entry.kind === "user" ? { backgroundColor: USER_BACKGROUND } : {}),
			});
			const detail = toolCall
				? new TextRenderable(this.renderer, {
						content: formatToolDetails(entry.tools),
						flexGrow: 1,
					})
				: undefined;
			const gutter =
				entry.kind === "user"
					? new TextRenderable(this.renderer, {
							content: "❯",
							width: 1,
							fg: entry.pending ? USER_PROMPT_PENDING : USER_PROMPT,
							marginRight: 1,
						})
					: undefined;
			if (toolCall) {
				row.add(text);
				if (detail) row.add(detail);
			} else {
				if (gutter) row.add(gutter);
				row.add(text);
			}
			this.root.add(row);
			this.renderedEntries.push(
				gutter
					? { row, text, kind: entry.kind, gutter }
					: detail
						? { row, text, kind: entry.kind, detail }
						: { row, text, kind: entry.kind },
			);
		}
		displayEntries.forEach((entry, index) => {
			const rendered = this.renderedEntries[index];
			if (!rendered) return;
			const toolCall = entry.kind === "tool-group";
			rendered.kind = entry.kind;
			rendered.row.visible =
				entry.kind !== "reasoning" || !this.disableThinkingBlocks;
			rendered.text.content = toolCall
				? formatToolTitle(entry.tools)
				: formatEntry(entry, this.skillNames, this.promptNames);
			rendered.text.fg = toolCall ? ACCENT : entryColor(entry);
			rendered.row.backgroundColor =
				entry.kind === "user" ? USER_BACKGROUND : undefined;
			if (rendered.detail && toolCall)
				rendered.detail.content = formatToolDetails(entry.tools);
			if (rendered.gutter && entry.kind === "user")
				rendered.gutter.fg = entry.pending ? USER_PROMPT_PENDING : USER_PROMPT;
		});
	}
}

function groupToolCalls(entries: TranscriptEntry[]): DisplayEntry[] {
	const grouped: DisplayEntry[] = [];
	for (const entry of entries) {
		const last = grouped.at(-1);
		if (entry.kind === "tool-call") {
			if (last?.kind === "tool-group") last.tools.push(entry);
			else grouped.push({ kind: "tool-group", tools: [entry] });
		} else grouped.push(entry);
	}
	return grouped;
}

function formatEntry(
	entry: TranscriptEntry,
	skillNames: ReadonlySet<string>,
	promptNames: ReadonlySet<string>,
): string | StyledText {
	const prefix = (
		{
			user: "",
			assistant: "",
			reasoning: "thinking: ",
			"tool-call": "",
			"tool-result": "↳ ",
			error: "error: ",
			status: "[",
			usage: "usage: ",
			compaction: "⋯ ",
			completed: "",
			aborted: "[",
		} as const
	)[entry.kind];
	if (entry.kind !== "user")
		return `${prefix}${entry.kind === "reasoning" ? entry.text.trimEnd() : entry.text}${["status", "aborted"].includes(entry.kind) ? "]" : ""}`;
	const chunks = [];
	let position = 0;
	for (const match of entry.text.matchAll(slashCommandPattern())) {
		const start = (match.index ?? 0) + (match[1] ?? "").length;
		const name = match[2] ?? "";
		const kind = skillNames.has(name)
			? "skill"
			: promptNames.has(name)
				? "prompt"
				: undefined;
		if (!expandsAt(kind, start)) continue;
		chunks.push(...t`${entry.text.slice(position, start)}`.chunks);
		chunks.push(fg(ACCENT)(entry.text.slice(start, start + name.length + 1)));
		position = start + name.length + 1;
	}
	chunks.push(...t`${entry.text.slice(position)}`.chunks);
	return new StyledText(chunks);
}

function formatToolTitle(entries: TranscriptEntry[]) {
	const groups = new Map<string, TranscriptEntry[]>();
	for (const entry of entries) {
		const key = summaryKey(entry.text);
		groups.set(key, [...(groups.get(key) ?? []), entry]);
	}
	return new StyledText(
		[...groups.values()].flatMap((group, index) => {
			const separator = index ? ", " : "";
			const capitalize = (verb: string) =>
				index ? verb : `${verb[0]?.toUpperCase()}${verb.slice(1)}`;
			/**
			 * A catalog search is about its query, not how many searches ran, so it
			 * reads as the question asked rather than a count of questions.
			 */
			if (group[0]?.text === "capabilities_search") {
				const queries = group
					.map((entry) => entry.subject)
					.filter((query): query is string => !!query)
					.map((query) => `"${query}"`)
					.join(", ");
				return t`${separator}${fg(ACCENT)(capitalize("searched"))} ${fg(TEXT)(queries ? `for ${queries}` : "the catalog")}`
					.chunks;
			}
			const [verb, noun] = toolSummary(group[0]?.text ?? "", group.length);
			return t`${separator}${fg(ACCENT)(capitalize(verb))} ${bold(fg(WARNING)(String(group.length)))} ${fg(TEXT)(noun)}`
				.chunks;
		}),
	);
}

/**
 * One indented line per call naming what it acted on. A failure is the
 * exception: its output is the only thing that explains itself, so it replaces
 * the subject rather than being dropped with the rest of the output.
 */
function formatToolDetails(entries: TranscriptEntry[]) {
	/**
	 * Loading a tool that is then called in the same group says it twice. The
	 * call's subject carries its argument too, so the names are compared rather
	 * than the whole line.
	 */
	const called = new Set(
		entries.flatMap((entry) => {
			const mcp = mcpToolName(entry.text);
			return mcp ? [`${mcp.server}: ${mcp.tool}`] : [];
		}),
	);
	const lines = entries.flatMap((entry) => {
		if (entry.error && entry.detail) {
			const output = entry.detail.replace(/\s+/g, " ").trim();
			return [
				{
					error: true,
					text: output.length > 50 ? `${output.slice(0, 50)}...` : output,
				},
			];
		}
		// A search states its query in the title already.
		if (!entry.subject || entry.text === "capabilities_search") return [];
		if (entry.text === "tools_load" && called.has(entry.subject)) return [];
		return [{ error: false, text: truncateSubject(entry.subject, entry.text) }];
	});
	if (!lines.length) return "";
	return new StyledText(
		lines.flatMap(
			(line, index) =>
				t`${fg(line.error ? ERROR : DIM)(`${index ? "\n" : ""}  ╰ ${line.text}`)}`
					.chunks,
		),
	);
}

const SUBJECT_WIDTH = 60;
/** Only a path is identified by its tail; everything else reads from the start. */
const TAIL_TOOLS = new Set(["read", "write", "edit"]);

function truncateSubject(subject: string, tool: string): string {
	const flat = subject.replace(/\s+/g, " ").trim();
	if (flat.length <= SUBJECT_WIDTH) return flat;
	if (TAIL_TOOLS.has(tool))
		return `…${flat.slice(flat.length - (SUBJECT_WIDTH - 1))}`;
	/** A trailing quote survives the cut so the line still reads as a quotation. */
	const closing = flat.endsWith('"') ? '"' : "";
	return `${flat.slice(0, SUBJECT_WIDTH - 1 - closing.length)}…${closing}`;
}

/** MCP tools share one bucket so a turn reads "used 2 tools", not two names. */
function summaryKey(name: string): string {
	return isMcpTool(name) ? " mcp" : name;
}

function toolSummary(name: string, count: number): [string, string] {
	const plural = count === 1 ? "" : "s";
	if (isMcpTool(name)) return ["used", `tool${plural}`];
	return ({
		bash: ["ran", `shell command${plural}`],
		read: ["read", `file${plural}`],
		write: ["wrote", `file${plural}`],
		edit: ["edited", `file${plural}`],
		tools_load: ["loaded", `tool${plural}`],
		skills_activate: ["activated", `skill${plural}`],
		capabilities_inspect: [
			"inspected",
			`capabilit${count === 1 ? "y" : "ies"}`,
		],
		capabilities_list: ["listed", `catalog page${plural}`],
	}[name] ?? ["used", `${name}${plural}`]) as [string, string];
}

function entryColor(entry: TranscriptEntry) {
	if (entry.error || entry.kind === "error") return ERROR;
	if (entry.kind === "user") return USER_TEXT;
	if (entry.kind === "reasoning") return DIM;
	if (entry.kind === "completed") return DIM;
	if (entry.kind.startsWith("tool")) return ACCENT;
	return TEXT;
}
