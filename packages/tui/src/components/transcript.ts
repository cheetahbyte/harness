import {
	BoxRenderable,
	type CliRenderer,
	ScrollBoxRenderable,
	TextRenderable,
} from "@opentui/core";
import type { TranscriptEntry } from "../store";

export class TranscriptView {
	readonly root: ScrollBoxRenderable;
	private readonly renderedEntries: {
		row: BoxRenderable;
		text: TextRenderable;
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
			const text = new TextRenderable(this.renderer, {
				content: formatEntry(entry),
				fg: entryColor(entry),
				flexGrow: 1,
			});
			const row = new BoxRenderable(this.renderer, {
				width: "100%",
				marginBottom: 1,
				flexDirection: "row",
			});
			const gutter =
				entry.kind === "user"
					? new TextRenderable(this.renderer, {
							content: "▎",
							fg: entry.pending ? "#6c7086" : "#cba6f7",
							marginRight: 1,
						})
					: undefined;
			if (gutter) row.add(gutter);
			row.add(text);
			this.root.add(row);
			this.renderedEntries.push(gutter ? { row, text, gutter } : { row, text });
		}
		entries.forEach((entry, index) => {
			const rendered = this.renderedEntries[index];
			if (!rendered) return;
			rendered.text.content = formatEntry(entry);
			rendered.text.fg = entryColor(entry);
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
			"tool-call": "→ ",
			"tool-result": "← ",
			error: "error: ",
			status: "[",
			usage: "usage: ",
			completed: "",
			aborted: "[",
		} as const
	)[entry.kind];
	return `${prefix}${entry.text}${["status", "aborted"].includes(entry.kind) ? "]" : ""}`;
}

function entryColor(entry: TranscriptEntry): string {
	if (entry.error || entry.kind === "error") return "#f38ba8";
	if (entry.kind === "reasoning") return "#a6adc8";
	if (entry.kind === "completed") return "#8b8d98";
	if (entry.kind.startsWith("tool")) return "#89b4fa";
	if (entry.kind === "user") return "#cba6f7";
	return "#cdd6f4";
}
