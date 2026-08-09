import { createStore } from "zustand/vanilla";
import type { ClientCommand, ServerEvent } from "../../shared/src/protocol";

export type TranscriptKind = "user" | "assistant" | "reasoning" | "tool-call" | "tool-result" | "error" | "status" | "usage" | "completed" | "aborted";
export type TranscriptEntry = { kind: TranscriptKind; text: string; error?: boolean; active?: boolean };

/** Projects protocol events for display; it does not own runtime or session behavior. */
export function createTuiStore(sessionId: string) {
  return createStore<TuiState>((set) => {
    const append = (entry: TranscriptEntry) => set((state) => ({ entries: [...finishActive(state.entries), entry] }));
    const delta = (kind: "assistant" | "reasoning", text: string) => set((state) => {
      const last = state.entries.at(-1);
      if (last?.kind === kind && last.active) return { entries: [...state.entries.slice(0, -1), { ...last, text: last.text + text }] };
      return { entries: [...finishActive(state.entries), { kind, text, active: true }] };
    });
    return {
      sessionId,
      entries: [],
      running: false,
      status: "ready",
      configuredStatus: "",
      apply(event) {
        if (event.type === "session") return;
        if (event.type === "assistant-delta") return delta("assistant", event.text);
        if (event.type === "assistant-reasoning-delta") return delta("reasoning", event.text);
        if (event.type === "tool-call") return append({ kind: "tool-call", text: `${event.name} ${JSON.stringify(event.input)}` });
        if (event.type === "tool-result") return append({ kind: "tool-result", text: `${event.name}: ${event.output}`, error: event.isError });
        if (event.type === "error") { set({ running: false }); return append({ kind: "error", text: event.message, error: true }); }
        if (event.type === "usage") return append({ kind: "usage", text: `in ${event.input} · out ${event.output} · total ${event.totalTokens}` });
        if (event.type === "completed" || event.type === "aborted") { set({ running: false }); return append({ kind: event.type, text: event.type }); }
        set((state) => ({
          status: event.text,
          configuredStatus: event.text.startsWith("configured ") ? event.text : state.configuredStatus,
          running: event.text === "running" ? true : state.running,
        }));
        append({ kind: "status", text: event.text });
      },
      addUser(text) { append({ kind: "user", text }); },
    };
  });
}

export type TuiState = {
  sessionId: string;
  entries: TranscriptEntry[];
  running: boolean;
  status: string;
  configuredStatus: string;
  apply: (event: ServerEvent) => void;
  addUser: (text: string) => void;
};

function finishActive(entries: TranscriptEntry[]): TranscriptEntry[] {
  const last = entries.at(-1); if (!last?.active) return entries;
  return [...entries.slice(0, -1), { ...last, active: false }];
}

export function parseModelStatus(status: string): string | undefined {
  // Temporary protocol compatibility adapter; replace when configuration is structured.
  return status.match(/^configured\s+(.+)$/)?.[1];
}

export function commandForInput(text: string): ClientCommand {
  const match = text.match(/^\/model\s+(openai-codex|openai-compatible)\s+(\S+)(?:\s+(\S+))?$/);
  return match ? { type: "configure", provider: match[1] as "openai-codex" | "openai-compatible", model: match[2], baseUrl: match[3] } : { type: "steer", text };
}
