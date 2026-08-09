import { BoxRenderable, InputRenderable, InputRenderableEvents, ScrollBoxRenderable, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";
import type { StoreApi } from "zustand/vanilla";
import type { ClientCommand } from "../../shared/src/protocol";
import { commandForInput, parseModelStatus, type TranscriptEntry, type TuiState } from "./store";

export class TuiApp {
  private readonly header: TextRenderable;
  private readonly transcript: ScrollBoxRenderable;
  private readonly composer: InputRenderable;
  private readonly renderedEntries: TextRenderable[] = [];
  private unsubscribe: () => void;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly store: StoreApi<TuiState>,
    private readonly send: (command: ClientCommand) => Promise<void>,
  ) {
    const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", padding: 1, backgroundColor: "#111318" });
    const top = new BoxRenderable(renderer, { width: "100%", flexDirection: "row", justifyContent: "space-between", marginBottom: 1 });
    this.header = new TextRenderable(renderer, { fg: "#cdd6f4" });
    top.add(this.header);
    root.add(top);

    this.transcript = new ScrollBoxRenderable(renderer, { width: "100%", flexGrow: 1, stickyScroll: true, stickyStart: "bottom", viewportCulling: true, paddingRight: 1 });
    root.add(this.transcript);

    const composerBox = new BoxRenderable(renderer, { width: "100%", marginTop: 1, border: true, borderStyle: "rounded", borderColor: "#45475a", paddingLeft: 1, paddingRight: 1 });
    this.composer = new InputRenderable(renderer, { width: "100%", placeholder: "Message Harness…", textColor: "#cdd6f4", focusedBackgroundColor: "#1e1e2e" });
    this.composer.on(InputRenderableEvents.ENTER, (value: string) => void this.submit(value));
    composerBox.add(this.composer);
    root.add(composerBox);
    root.add(new TextRenderable(renderer, { content: "Enter steer · Option+Enter follow-up · Esc abort", fg: "#6c7086" }));
    renderer.root.add(root);
    this.unsubscribe = store.subscribe(() => this.sync());
    renderer.keyInput.prependListener("keypress", this.handleKey);
    this.sync();
    this.composer.focus();
  }

  destroy() {
    this.unsubscribe();
    this.renderer.keyInput.off("keypress", this.handleKey);
  }

  private handleKey = (key: KeyEvent) => {
    if (key.name === "escape") {
      key.preventDefault();
      void this.send({ type: "abort" });
      return;
    }
    if (key.name === "return" && (key.option || key.meta)) {
      key.preventDefault();
      void this.submit(this.composer.value, true);
    }
  }

  private async submit(text: string, followUp = false) {
    if (!text.trim()) return;
    const command = followUp ? { type: "follow-up" as const, text } : commandForInput(text);
    if (command.type === "steer" || command.type === "follow-up") this.store.getState().addUser(text);
    try {
      await this.send(command);
      this.composer.value = "";
    } catch (error) {
      this.store.getState().apply({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private sync() {
    const state = this.store.getState();
    const model = parseModelStatus(state.configuredStatus) ?? "no model";
    this.header.content = `Harness  ${state.sessionId}    ${state.running ? "running" : "idle"}  ${model}`;
    for (let index = this.renderedEntries.length; index < state.entries.length; index++) {
      const entry = state.entries[index];
      const text = new TextRenderable(this.renderer, { content: formatEntry(entry), fg: entryColor(entry) });
      const row = new BoxRenderable(this.renderer, { width: "100%", marginBottom: 1 });
      row.add(text);
      this.transcript.add(row);
      this.renderedEntries.push(text);
    }
    const last = state.entries.at(-1);
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
