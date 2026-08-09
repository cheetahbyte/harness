import { BoxRenderable, ScrollBoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import type { TranscriptEntry } from "../store";

export class TranscriptView {
  readonly root: ScrollBoxRenderable;
  private readonly renderedEntries: TextRenderable[] = [];

  constructor(private readonly renderer: CliRenderer) {
    this.root = new ScrollBoxRenderable(renderer, { width: "100%", flexGrow: 1, stickyScroll: true, stickyStart: "bottom", viewportCulling: true, paddingRight: 1 });
  }

  update(entries: TranscriptEntry[]) {
    for (let index = this.renderedEntries.length; index < entries.length; index++) {
      const entry = entries[index];
      const text = new TextRenderable(this.renderer, { content: formatEntry(entry), fg: entryColor(entry) });
      const row = new BoxRenderable(this.renderer, { width: "100%", marginBottom: 1 });
      row.add(text);
      this.root.add(row);
      this.renderedEntries.push(text);
    }
    const last = entries.at(-1);
    const renderedLast = this.renderedEntries.at(-1);
    if (last && renderedLast) renderedLast.content = formatEntry(last);
  }
}

function formatEntry(entry: TranscriptEntry): string {
  const prefix = ({ user: "> ", assistant: "", reasoning: "thinking: ", "tool-call": "→ ", "tool-result": "← ", error: "error: ", status: "[", usage: "usage: ", completed: "[", aborted: "[" } as const)[entry.kind];
  return `${prefix}${entry.text}${["status", "completed", "aborted"].includes(entry.kind) ? "]" : ""}`;
}

function entryColor(entry: TranscriptEntry): string {
  if (entry.error || entry.kind === "error") return "#f38ba8";
  if (entry.kind === "reasoning") return "#a6adc8";
  if (entry.kind.startsWith("tool")) return "#89b4fa";
  if (entry.kind === "user") return "#cba6f7";
  return "#cdd6f4";
}
