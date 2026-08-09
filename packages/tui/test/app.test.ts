import { describe, expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiApp } from "../src/app";
import { createTuiStore } from "../src/store";

describe("OpenTUI app", () => {
	test("renders replayed transcript and updates the active streamed tail", async () => {
		const store = createTuiStore("session-1");
		store
			.getState()
			.apply({ type: "status", text: "configured openai-codex/gpt-5.6-sol" });
		store.getState().apply({
			type: "tool-result",
			id: "read-1",
			name: "read",
			output: "hello",
		});
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			expect(view.captureCharFrame()).toContain("openai-codex/gpt-5.6-sol");
			expect(view.captureCharFrame()).toContain("read: hello");
			expect(view.captureCharFrame()).toContain("›");
			expect(view.captureCharFrame()).toContain("▶▶");
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
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command.type);
		});
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

	test("copies the selected transcript text with Cmd-C", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const copied: string[] = [];
		const renderer = view.renderer as unknown as {
			getSelection: () => { getSelectedText: () => string } | null;
			copyToClipboardOSC52: (text: string) => boolean;
		};
		renderer.getSelection = () => ({ getSelectedText: () => "copied text" });
		renderer.copyToClipboardOSC52 = (text) => {
			copied.push(text);
			return true;
		};
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			view.mockInput.pressKey("c", { super: true });
			await Promise.resolve();
			expect(copied).toEqual(["copied text"]);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("clears the composer before an in-flight command resolves", async () => {
		const store = createTuiStore("session-1");
		let resolveSend!: () => void;
		const send = new Promise<void>((resolve) => {
			resolveSend = resolve;
		});
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => send);
		try {
			await view.renderOnce();
			await view.mockInput.typeText("write tests");
			view.mockInput.pressEnter();
			await Promise.resolve();
			expect(
				(app as unknown as { composer: { value: string } }).composer.value,
			).toBe("");
			resolveSend();
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("renders queued follow-ups above the composer", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			store.getState().addFollowUp("follow-1", "after this");
			await view.flush();
			expect(view.captureCharFrame()).toContain("1 queued · after this");
			store.getState().apply({
				type: "command",
				id: "follow-1",
				command: "follow-up",
				state: "started",
			});
			await view.flush();
			expect(view.captureCharFrame()).toContain("sending · after this");
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("keeps submitted steering muted until the agent starts it", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.mockInput.typeText("new direction");
			view.mockInput.pressEnter();
			await Promise.resolve();
			const id = store.getState().entries.at(-1)?.id;
			expect(store.getState().entries.at(-1)).toMatchObject({
				text: "new direction",
				pending: true,
			});
			store.getState().apply({
				type: "command",
				id: id!,
				command: "steer",
				state: "started",
			});
			expect(store.getState().entries.at(-1)).toMatchObject({ pending: false });
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});
});
