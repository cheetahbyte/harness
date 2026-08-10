import {
	BoxRenderable,
	bold,
	type CliRenderer,
	fg,
	ScrollBoxRenderable,
	TextRenderable,
	t,
} from "@opentui/core";
import type { TranscriptEntry } from "../store";

export class TranscriptView {
	readonly root: ScrollBoxRenderable;
	private readonly renderedEntries: {
		row: BoxRenderable;
		text: TextRenderable;
		detail?: TextRenderable;
		gutter?: TextRenderable;
	}[] = [];

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

	update(entries: TranscriptEntry[]) {
		if (entries.length < this.renderedEntries.length) {
			for (const { row } of this.renderedEntries) this.root.remove(row);
			this.renderedEntries.length = 0;
		}
		for (
			let index = this.renderedEntries.length;
			index < entries.length;
			index++
		) {
			const entry = entries[index];
			if (!entry) continue;
			const toolCall = entry.kind === "tool-call";
			const text = new TextRenderable(this.renderer, {
				content: toolCall ? formatToolTitle(entry) : formatEntry(entry),
				fg: entryColor(entry),
				flexGrow: 1,
			});
			const row = new BoxRenderable(this.renderer, {
				width: "100%",
				marginBottom: 1,
				flexDirection: toolCall ? "column" : "row",
			});
			const detail = toolCall
				? new TextRenderable(this.renderer, {
						content: formatToolDetail(entry),
						flexGrow: 1,
					})
				: undefined;
			const gutter =
				entry.kind === "user"
					? new TextRenderable(this.renderer, {
							content: "▎",
							fg: entry.pending ? "#6c7086" : "#cba6f7",
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
					? { row, text, gutter }
					: detail
						? { row, text, detail }
						: { row, text },
			);
		}
		entries.forEach((entry, index) => {
			const rendered = this.renderedEntries[index];
			if (!rendered) return;
			rendered.text.content = rendered.detail
				? formatToolTitle(entry)
				: formatEntry(entry);
			rendered.text.fg = entryColor(entry);
			if (rendered.detail) rendered.detail.content = formatToolDetail(entry);
			if (rendered.gutter)
				rendered.gutter.fg = entry.pending ? "#6c7086" : "#cba6f7";
		});
	}
}

function formatEntry(entry: TranscriptEntry): string {
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
			completed: "",
			aborted: "[",
		} as const
	)[entry.kind];
	return `${prefix}${entry.text}${["status", "aborted"].includes(entry.kind) ? "]" : ""}`;
}

function formatToolTitle(entry: TranscriptEntry) {
	return t`Ran ${bold(fg("#f9e2af")("1"))} ${fg("#cdd6f4")(toolName(entry.text))}`;
}

function formatToolDetail(entry: TranscriptEntry) {
	if (!entry.detail) return "";
	return t`${fg(entry.error ? "#f38ba8" : "#a6adc8")(`╰ ${entry.detail}`)}`;
}

function toolName(name: string): string {
	return (
		{
			bash: "shell command",
			read: "file read",
			write: "file write",
			edit: "file edit",
		}[name] ?? name
	);
}

function entryColor(entry: TranscriptEntry): string {
	if (entry.error || entry.kind === "error") return "#f38ba8";
	if (entry.kind === "reasoning") return "#a6adc8";
	if (entry.kind === "completed") return "#8b8d98";
	if (entry.kind.startsWith("tool")) return "#89b4fa";
	if (entry.kind === "user") return "#cba6f7";
	return "#cdd6f4";
}
