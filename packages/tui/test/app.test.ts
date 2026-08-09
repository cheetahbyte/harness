import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiApp } from "../src/app";
import { createTuiStore } from "../src/store";

describe("OpenTUI app", () => {
  test("renders replayed transcript and updates the active streamed tail", async () => {
    const store = createTuiStore("session-1");
    store.getState().apply({ type: "status", text: "configured openai-codex/gpt-5.6-sol" });
    store.getState().apply({ type: "tool-result", id: "read-1", name: "read", output: "hello" });
    const view = await createTestRenderer({ width: 72, height: 20, kittyKeyboard: true });
    const app = new TuiApp(view.renderer, store, async () => {});
    try {
      await view.renderOnce();
      expect(view.captureCharFrame()).toContain("openai-codex/gpt-5.6-sol");
      expect(view.captureCharFrame()).toContain("read: hello");
      store.getState().apply({ type: "assistant-delta", text: "stream" });
      store.getState().apply({ type: "assistant-delta", text: "ing" });
      await view.flush();
      expect(view.captureCharFrame()).toContain("streaming");
    } finally {
      app.destroy();
      view.renderer.destroy();
    }
  });

  test("Escape aborts even when the composer has text", async () => {
    const store = createTuiStore("session-1");
    const sent: string[] = [];
    const view = await createTestRenderer({ width: 72, height: 20, kittyKeyboard: true });
    const app = new TuiApp(view.renderer, store, async (command) => { sent.push(command.type); });
    try {
      await view.renderOnce();
      await view.mockInput.typeText("keep this text");
      view.mockInput.pressEscape();
      await Promise.resolve();
      expect(sent).toEqual(["abort"]);
    } finally {
      app.destroy();
      view.renderer.destroy();
    }
  });
});
