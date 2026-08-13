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
import type { TranscriptEntry } from "../store";
import {
	ACCENT,
	DIM,
	ERROR,
	TEXT,
	USER_BACKGROUND,
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
				...(entry.kind === "user" ? { marginTop: 1, marginBottom: 1 } : {}),
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
							content: "▌\n▌\n▌",
							width: 1,
							fg: entry.pending ? DIM : ACCENT,
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
				rendered.gutter.fg = entry.pending ? DIM : ACCENT;
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
	const counts = new Map<string, number>();
	for (const entry of entries)
		counts.set(entry.text, (counts.get(entry.text) ?? 0) + 1);
	return new StyledText(
		[...counts].flatMap(([name, count], index) => {
			const [verb, noun] = toolSummary(name, count);
			const label = index ? verb : `${verb[0]?.toUpperCase()}${verb.slice(1)}`;
			return t`${index ? ", " : ""}${fg(ACCENT)(label)} ${bold(fg(WARNING)(String(count)))} ${fg(TEXT)(noun)}`
				.chunks;
		}),
	);
}

function formatToolDetails(entries: TranscriptEntry[]) {
	const details = entries.filter((entry) => entry.detail);
	if (!details.length) return "";
	return new StyledText(
		details.flatMap((entry, index) => {
			const output = entry.detail?.replace(/\s+/g, " ").trim() ?? "";
			const preview = output.length > 50 ? `${output.slice(0, 50)}...` : output;
			return t`${fg(entry.error ? ERROR : DIM)(`${index ? "\n" : ""}╰ ${preview}`)}`
				.chunks;
		}),
	);
}

function toolSummary(name: string, count: number): [string, string] {
	const plural = count === 1 ? "" : "s";
	return ({
		bash: ["ran", `shell command${plural}`],
		read: ["read", `file${plural}`],
		write: ["wrote", `file${plural}`],
		edit: ["edited", `file${plural}`],
	}[name] ?? ["used", `${name}${plural}`]) as [string, string];
}

function entryColor(entry: TranscriptEntry) {
	if (entry.error || entry.kind === "error") return ERROR;
	if (entry.kind === "user") return USER_TEXT;
	if (entry.kind === "reasoning") return DIM;
	if (entry.kind === "completed") return DIM;
	if (entry.kind === "compaction") return DIM;
	if (entry.kind.startsWith("tool")) return ACCENT;
	return TEXT;
}
