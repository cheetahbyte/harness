import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { VERSION } from "../../shared/src/version";
import { TuiApp } from "../src/app";
import {
	ACCENT,
	DIM,
	TEXT,
	USER_BACKGROUND,
	USER_TEXT,
	thinkingColor,
} from "../src/components/theme";
import { createTuiStore } from "../src/store";

/** The footer is the last rendered row, below the composer's lower rule. */
function footerLine(frame: string) {
	return frame.split("\n").findLast((line) => line.includes("(")) ?? "";
}

describe("OpenTUI app", () => {
	test("renders replayed transcript and updates the active streamed tail", async () => {
		const store = createTuiStore("session-1", `${homedir()}/project`);
		store
			.getState()
			.apply({
				type: "model-config",
				config: { provider: "openai-codex", model: "gpt-5.6-sol" },
			});
		store.getState().apply({
			type: "tool-call",
			id: "read-1",
			name: "read",
			input: { path: "note.txt" },
		});
		store.getState().apply({
			type: "tool-result",
			id: "read-1",
			name: "read",
			output: `hello\n${"x".repeat(60)}`,
		});
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			const frame = view.captureCharFrame();
			expect(frame).toContain("gpt-5.6-sol (openai-codex)");
			expect(frame).toContain(`Harnez v${VERSION}`);
			expect(frame).toContain("gpt-5.6-sol · openai-codex · idle");
			expect(frame).toContain("~/project");
			expect(frame).toContain("◆");
			expect(footerLine(frame)).not.toContain("~/project");
			expect(view.captureCharFrame()).toContain("Read 1 file");
			/** The path read, not the bytes it returned. */
			expect(view.captureCharFrame()).toContain("╰ note.txt");
			expect(view.captureCharFrame()).not.toContain("x".repeat(45));
			expect(view.captureCharFrame()).toContain("›");
			store.getState().apply({ type: "assistant-delta", text: "stream" });
			store.getState().apply({ type: "assistant-delta", text: "ing" });
			await view.flush();
			expect(view.captureCharFrame()).toContain("streaming");
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("uses the terminal foreground for essential text on a light background", async () => {
		const store = createTuiStore("session-1");
		store.getState().apply({ type: "assistant-delta", text: "visible answer" });
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			backgroundColor: "#ffffff",
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			const spans = view.captureSpans().lines.flatMap((line) => line.spans);
			expect(spans.find((span) => span.text.includes("Harnez"))?.fg.equals(TEXT)).toBe(
				true,
			);
			expect(
				spans.find((span) => span.text.includes("visible answer"))?.fg.equals(TEXT),
			).toBe(true);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("shows update notices beside the installed version", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({ width: 100, height: 20 });
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			app.setNotice({
				full: "update available: 9.9.9 · install via `harnez update`",
				short: "update 9.9.9",
			});
			await view.flush();
			let title = view
				.captureCharFrame()
				.split("\n")
				.find((line) => line.includes("Harnez"));
			expect(title).toContain(
				`Harnez v${VERSION} · update available: 9.9.9 · install via \`harnez update\``,
			);

			view.resize(40, 20);
			await view.flush();
			title = view
				.captureCharFrame()
				.split("\n")
				.find((line) => line.includes("Harnez"));
			expect(title).toContain(`Harnez v${VERSION} · update 9.9.9`);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("groups consecutive tool calls by operation", async () => {
		const store = createTuiStore("session-1");
		for (const [id, name, input] of [
			["bash-1", "bash", { command: "bun test" }],
			["read-1", "read", { path: "one.ts" }],
			["read-2", "read", { path: "two.ts" }],
		] as const) {
			store.getState().apply({ type: "tool-call", id, name, input });
			store.getState().apply({
				type: "tool-result",
				id,
				name,
				output: `${id} output`,
			});
		}
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			const frame = view.captureCharFrame();
			expect(frame).toContain("Ran 1 shell command, read 2 files");
			expect(frame).toContain("╰ bun test");
			expect(frame).toContain("╰ two.ts");
			/** Output is not worth a transcript line. */
			expect(frame).not.toContain("bash-1 output");
			expect(frame.match(/Ran|Read/g)).toHaveLength(1);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("renders catalog discovery as a query and tool names", async () => {
		const store = createTuiStore("session-1");
		const calls = [
			[
				"c-1",
				"capabilities_search",
				{ query: "aachen fire" },
				'{"items":[{"ref":{"id":"tool:mcp__ddg-search__search"}}]}',
			],
			[
				"c-2",
				"tools_load",
				{ id: "tool:mcp__ddg-search__search" },
				"Loaded mcp__ddg-search__search",
			],
			[
				"c-3",
				"mcp__ddg-search__search",
				{ query: "aachen fire" },
				"Found 10 search results: 1. Grossbraende in Aachen",
			],
		] as const;
		for (const [id, name, input, output] of calls) {
			store.getState().apply({ type: "tool-call", id, name, input });
			store.getState().apply({ type: "tool-result", id, name, output });
		}
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			const frame = view.captureCharFrame();
			expect(frame).toContain('Searched for "aachen fire"');
			expect(frame).toContain("loaded 1 tool");
			expect(frame).toContain("used 1 tool");
			/** The routing name never reaches the screen, but the argument does. */
			expect(frame).toContain('╰ ddg-search: search "aachen fire"');
			expect(frame).not.toContain("mcp__ddg-search__search");
			expect(frame).not.toContain("Found 10 search results");
			expect(frame).not.toContain('{"items"');
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("keeps a failing tool's output, which is the only thing that explains it", async () => {
		const store = createTuiStore("session-1");
		store.getState().apply({
			type: "tool-call",
			id: "bash-1",
			name: "bash",
			input: { command: "exit 1" },
		});
		store.getState().apply({
			type: "tool-result",
			id: "bash-1",
			name: "bash",
			output: "exit 1: command not found",
			isError: true,
		});
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			expect(view.captureCharFrame()).toContain("╰ exit 1: command not found");
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("ignores trailing whitespace when laying out thinking blocks", async () => {
		const store = createTuiStore("session-1");
		store.getState().apply({
			type: "assistant-reasoning-delta",
			text: "Inspecting files\n\n\n",
		});
		store.getState().apply({
			type: "tool-call",
			id: "read-1",
			name: "read",
			input: {},
		});
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			const lines = view.captureCharFrame().split("\n");
			const thinking = lines.findIndex((line) => line.includes("thinking:"));
			const tool = lines.findIndex((line) => line.includes("Read 1 file"));
			expect(tool - thinking - 1).toBe(1);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("scrolls a long transcript entry instead of clipping it to the viewport", async () => {
		const store = createTuiStore("session-1");
		store.getState().apply({
			type: "assistant-delta",
			text: "word ".repeat(2_000),
		});
		const view = await createTestRenderer({
			width: 40,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			expect(view.captureCharFrame()).not.toContain("Harnez  session-1");
			const transcript = (
				app as unknown as {
					transcript: { root: { scrollHeight: number; height: number } };
				}
			).transcript;
			expect(transcript.root.scrollHeight).toBeGreaterThan(transcript.root.height);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("toggles thinking blocks with Ctrl-T", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		store.getState().apply({
			type: "assistant-reasoning-delta",
			text: "checking the implementation",
		});
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			await view.flush();
			expect(view.captureCharFrame()).toContain("thinking: checking");
			view.mockInput.pressKey("t", { ctrl: true });
			await view.flush();
			expect(view.captureCharFrame()).not.toContain("thinking: checking");
			view.mockInput.pressKey("t", { ctrl: true });
			await view.flush();
			expect(view.captureCharFrame()).toContain("thinking: checking");
			expect(sent).toEqual([
				{ type: "set-disable-thinking-blocks", disabled: true },
				{ type: "set-disable-thinking-blocks", disabled: false },
			]);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("cycles and displays the model thinking level with Shift-Tab", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		store.getState().apply({
			type: "model-config",
			config: {
				provider: "openai-codex",
				model: "gpt-5.6-sol",
				thinkingLevel: "medium",
			},
		});
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			await view.flush();
			expect(view.captureCharFrame()).toContain("medium");
			const composer = (
				app as unknown as {
					composer: { inputRow: { borderColor: RGBA } };
				}
			).composer;
			expect(composer.inputRow.borderColor.equals(thinkingColor("medium"))).toBe(
				true,
			);
			await view.mockInput.typeText("/");
			await view.flush();
			expect(view.captureCharFrame()).toContain("/model");
			view.mockInput.pressTab({ shift: true });
			await view.flush();
			expect(sent).toEqual([{ type: "cycle-thinking-level" }]);
			store.getState().apply({
				type: "model-config",
				config: {
					provider: "openai-codex",
					model: "gpt-5.6-sol",
					thinkingLevel: "high",
				},
			});
			await view.flush();
			expect(view.captureCharFrame()).toContain("high");
			expect(composer.inputRow.borderColor.equals(thinkingColor("high"))).toBe(
				true,
			);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("keeps the composer usable in a short terminal", async () => {
		const store = createTuiStore("session-1");
		store.getState().apply({
			type: "assistant-delta",
			text: "word ".repeat(2_000),
		});
		const view = await createTestRenderer({
			width: 40,
			height: 6,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			const layout = app as unknown as {
				header: { root: { visible: boolean } };
				footer: { root: { visible: boolean } };
				composer: { root: { height: number } };
			};
			expect(layout.header.root.visible).toBe(false);
			expect(layout.footer.root.visible).toBe(false);
			expect(layout.composer.root.height).toBe(2);
			view.resize(40, 20);
			await view.flush();
			expect(layout.header.root.visible).toBe(true);
			expect(layout.footer.root.visible).toBe(true);
			expect(layout.composer.root.height).toBe(3);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("animates a running indicator above the input", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({ width: 72, height: 20 });
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			store.getState().apply({
				type: "task-state",
				taskId: "task-1",
				state: "running",
			});
			await view.renderOnce();
			expect(view.captureCharFrame()).toContain(
				"⠋ doing the minimum, professionally",
			);
			expect(view.captureCharFrame()).not.toContain("01001101");

			const composer = (
				app as unknown as { composer: { advanceRunning: () => void } }
			).composer;
			composer.advanceRunning();
			await view.renderOnce();
			expect(view.captureCharFrame()).toContain(
				"⠙ doing the minimum, professionally",
			);

			store.getState().apply({
				type: "task-state",
				taskId: "task-1",
				state: "terminal",
			});
			await view.renderOnce();
			expect(view.captureCharFrame()).not.toContain("⠙");

			store.getState().apply({
				type: "task-state",
				taskId: "task-2",
				state: "running",
			});
			await view.renderOnce();
			expect(view.captureCharFrame()).toContain(
				"⠋ asking the type checker to look away",
			);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("shows the leverage readout and sheds detail as the footer narrows", async () => {
		const store = createTuiStore("session-1", `${homedir()}/project`);
		store.getState().apply({
			type: "model-config",
			config: { provider: "anthropic", model: "opus-5" },
		});
		store.getState().apply({
			type: "context-status",
			liveTokens: 26_000,
			historyTokens: 120_000,
			parkedObservations: 95,
			budget: 160_000,
			target: 120_000,
		});
		store.getState().apply({
			type: "usage",
			input: 1_000,
			output: 100,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1_100,
			costUsd: 0.0042,
		});
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.flush();
			const wide = footerLine(view.captureCharFrame());
			expect(wide.indexOf("opus-5")).toBeLessThan(wide.indexOf("≡ 120k"));
			expect(wide.indexOf("≡ 120k")).toBeLessThan(wide.indexOf("Σ 0.0042$"));
			view.resize(46, 20);
			await view.flush();
			const narrow = footerLine(view.captureCharFrame());
			expect(narrow).toContain("Σ 0.0042$");
			expect(narrow).not.toContain("recallable");
			expect(narrow).toContain("opus-5 (anthropic)");
			view.resize(34, 20);
			await view.flush();
			const narrowest = footerLine(view.captureCharFrame());
			expect(narrowest).not.toContain("↦");
			expect(narrowest).toContain("opus-5 (anthropic)");
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

	test("wraps composer text and grows the input box to fit it", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 40,
			height: 30,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		const composer = (app as unknown as { composer: { root: { height: number } } })
			.composer;
		try {
			await view.renderOnce();
			expect(composer.root.height).toBe(3);
			await view.mockInput.typeText("word ".repeat(30));
			await view.flush();
			/** Five wrapped rows between the top and bottom borders. */
			expect(composer.root.height).toBe(7);
			/** A wider terminal rewraps the same text into fewer rows. */
			view.resize(100, 30);
			await view.flush();
			expect(composer.root.height).toBe(4);
			/** Past the cap the textarea scrolls with the cursor instead of growing. */
			view.resize(40, 30);
			await view.mockInput.typeText("word ".repeat(70));
			await view.flush();
			expect(composer.root.height).toBe(12);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("refocuses the composer on the first keypress after focus is lost", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.renderOnce();
			expect(view.renderer.currentFocusedEditor?.cursorStyle.style).toBe("line");
			view.renderer.currentFocusedEditor?.blur();
			expect(view.renderer.currentFocusedEditor).toBeNull();
			await view.mockInput.typeText("x");
			expect(
				(app as unknown as { composer: { value: string } }).composer.value,
			).toBe("x");
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("Shift+Enter breaks the line instead of submitting", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			await view.renderOnce();
			const composer = (
				app as unknown as { composer: { root: { height: number } } }
			).composer;
			expect(composer.root.height).toBe(3);
			await view.mockInput.typeText("first");
			view.mockInput.pressEnter({ shift: true });
			await view.mockInput.typeText("second");
			await view.flush();
			expect(composer.root.height).toBe(4);
			expect(sent).toHaveLength(0);
			expect(
				(app as unknown as { composer: { value: string } }).composer.value,
			).toBe("first\nsecond");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent).toEqual([
				expect.objectContaining({ type: "steer", text: "first\nsecond" }),
			]);
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

	test("suggests and completes slash commands", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.renderOnce();
			await view.mockInput.typeText("/m");
			await view.flush();
			expect(view.captureCharFrame()).toContain(
				"/model  Configure provider and model",
			);
			view.mockInput.pressTab();
			await view.flush();
			expect((app as unknown as { composer: { value: string } }).composer.value).toBe(
				"/model ",
			);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("sets the current session name", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			await view.renderOnce();
			await view.mockInput.typeText("/session-n");
			await view.flush();
			expect(view.captureCharFrame()).toContain(
				"/session-name  Set the current session name",
			);
			view.mockInput.pressTab();
			await view.mockInput.typeText("My project");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent).toEqual([
				{ type: "set-session-title", title: "My project" },
			]);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("recovers a blocked queued task with its implicit id", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			store.getState().addFollowUp("queued-1", "wait for success");
			store.getState().apply({
				type: "task-state",
				taskId: "queued-1",
				state: "blocked",
			});
			await view.renderOnce();
			expect(view.captureCharFrame()).toContain("blocked (queued-1)");
			await view.mockInput.typeText("/replace-queued continue now");
			view.mockInput.pressEnter();
			await Promise.resolve();
			expect(sent).toEqual([
				{ type: "replace-queued", taskId: "queued-1", text: "continue now" },
			]);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("suggests skills inside a prompt", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			store.getState().apply({
				type: "skills",
				skills: [{ name: "review", description: "Review a change" }],
			});
			await view.renderOnce();
			await view.mockInput.typeText("Please /r");
			await view.flush();
			expect(view.captureCharFrame()).toContain("/review  Review a change");
			expect(view.captureCharFrame()).not.toContain("/model");
			view.mockInput.pressTab();
			await view.flush();
			expect((app as unknown as { composer: { value: string } }).composer.value).toBe(
				"Please /review ",
			);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("uses the accent for processed messages and their skills", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			store.getState().apply({
				type: "skills",
				skills: [{ name: "codebase-design", description: "Design modules" }],
			});
			store.getState().addUser("Use /codebase-design");
			await view.flush();
			const spans = view.captureSpans().lines.flatMap((line) => line.spans);
			const gutter = spans.filter((span) => span.text === "▌");
			expect(gutter).toHaveLength(3);
			expect(gutter.every((span) => span.fg.equals(ACCENT))).toBe(true);
			expect(
				spans.find((span) => span.text === "/codebase-design")?.fg.equals(ACCENT),
			).toBe(true);
			const userText = spans.find((span) => span.text.includes("Use"));
			expect(userText?.fg.equals(USER_TEXT)).toBe(true);
			expect(userText?.bg.equals(USER_BACKGROUND)).toBe(true);
			const messageLine = view
				.captureSpans()
				.lines.findIndex((line) =>
					line.spans.some((span) => span.text.includes("Use")),
				);
			for (const line of view.captureSpans().lines.slice(messageLine - 1, messageLine + 2))
				expect(line.spans.some((span) => span.bg.equals(USER_BACKGROUND))).toBe(
					true,
				);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("suggests prompt templates as their own command only at the start", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			store.getState().apply({
				type: "prompts",
				prompts: [{ name: "review-pr", description: "Review a pull request" }],
			});
			store.getState().apply({
				type: "skills",
				skills: [{ name: "review-pr", description: "Shadowed by the template" }],
			});
			await view.renderOnce();
			await view.mockInput.typeText("/rev");
			await view.flush();
			expect(view.captureCharFrame()).toContain(
				"/review-pr  Review a pull request",
			);
			expect(view.captureCharFrame()).not.toContain("Shadowed by the template");
			await view.mockInput.typeText("iew-pr and then /rev");
			await view.flush();
			expect(view.captureCharFrame()).not.toContain("Review a pull request");
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("uses the accent for a leading prompt template only", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			store.getState().apply({
				type: "prompts",
				prompts: [{ name: "standup", description: "Daily standup" }],
			});
			store.getState().addUser("/standup after /standup");
			await view.flush();
			const accented = view
				.captureSpans()
				.lines.flatMap((line) => line.spans)
				.filter(
					(span) =>
						span.text === "/standup" && span.fg.equals(ACCENT),
				);
			expect(accented).toHaveLength(1);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("limits and truncates slash suggestions", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 40,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			store.getState().apply({
				type: "skills",
				skills: Array.from({ length: 5 }, (_, index) => ({
					name: `s${index + 1}`,
					description: "A description that is too long for this suggestion row",
				})),
			});
			await view.renderOnce();
			await view.mockInput.typeText("/s");
			await view.flush();
			const frame = view.captureCharFrame();
			expect(frame).toContain("/s1");
			expect(frame).not.toContain("/s5");
			expect(frame).not.toContain("suggestion row");
			for (let index = 0; index < 6; index++) view.mockInput.pressArrow("down");
			await view.flush();
			expect(view.captureCharFrame()).toContain("/s5");
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("does not truncate slash command names", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 40,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			store.getState().apply({
				type: "skills",
				skills: [
					{
						name: "vercel-react-best-practices",
						description: "A description that should truncate",
					},
				],
			});
			await view.renderOnce();
			await view.mockInput.typeText("/v");
			await view.flush();
			expect(view.captureCharFrame()).toContain("/vercel-react-best-practices");
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("submits the selected slash command with Enter", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			await view.renderOnce();
			await view.mockInput.typeText("/m");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent).toEqual([{ type: "list-models" }]);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("drives login prompts without rendering a secret", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			await view.renderOnce();
			await view.mockInput.typeText("/login");
			await view.flush();
			expect(view.captureCharFrame()).toContain(
				"/login  Configure provider authentication",
			);
			await view.mockInput.typeText(" ");
			view.mockInput.pressEnter();
			await view.flush();
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({ type: "list-providers", authType: "oauth" });
			store.getState().apply({
				type: "providers",
				providers: [
					{
						id: "openai-codex",
						name: "OpenAI Codex",
						authTypes: ["oauth"],
						configured: true,
					},
				],
			});
			await view.flush();
			expect(view.captureCharFrame()).toContain("OpenAI Codex · configured");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({
				type: "login",
				provider: "openai-codex",
				authType: "oauth",
			});
			store.getState().apply({
				type: "auth-prompt",
				prompt: { id: "prompt-1", type: "secret", message: "API key" },
			});
			await view.mockInput.typeText("secret");
			await view.flush();
			expect(view.captureCharFrame()).not.toContain("secret");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({
				type: "auth-answer",
				promptId: "prompt-1",
				value: "secret",
			});
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("shows and opens an OAuth authorization URL", async () => {
		const store = createTuiStore("session-1");
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const opened: string[][] = [];
		const spawn = Bun.spawn;
		(Bun as unknown as { spawn: (command: string[]) => unknown }).spawn = (
			command,
		) => {
			opened.push(command);
			return { exited: Promise.resolve(0) };
		};
		const app = new TuiApp(view.renderer, store, async () => {});
		try {
			await view.renderOnce();
			await view.mockInput.typeText("/login ");
			view.mockInput.pressEnter();
			view.mockInput.pressEnter();
			store.getState().apply({
				type: "providers",
				providers: [
					{
						id: "openai-codex",
						name: "OpenAI Codex",
						authTypes: ["oauth"],
						configured: true,
					},
				],
			});
			await view.flush();
			view.mockInput.pressEnter();
			store.getState().apply({
				type: "auth-notify",
				notification: {
					type: "auth_url",
					url: "https://example.com/authorize",
				},
			});
			store.getState().apply({
				type: "auth-prompt",
				prompt: {
					id: "prompt-1",
					type: "manual_code",
					message: "Complete login in your browser, or paste the redirect URL here:",
					placeholder: "http://localhost:1455/auth/callback",
				},
			});
			await view.flush();
			expect(view.captureCharFrame()).toContain("https://example.com/authorize");
			view.mockInput.pressKey("o", { ctrl: true });
			await Promise.resolve();
			const expectedCommand =
				process.platform === "darwin"
					? ["open", "https://example.com/authorize"]
					: process.platform === "win32"
						? ["cmd", "/c", "start", "", "https://example.com/authorize"]
						: ["xdg-open", "https://example.com/authorize"];
			expect(opened).toEqual([expectedCommand]);
		} finally {
			(Bun as unknown as { spawn: typeof Bun.spawn }).spawn = spawn;
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("selects a configured model and prioritizes wizard Escape", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			await view.renderOnce();
			await view.mockInput.typeText("/model ");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({ type: "list-models" });
			store.getState().apply({
				type: "models",
				models: [
					{
						provider: "openai-codex",
						providerName: "OpenAI Codex",
						id: "gpt-5.6-sol",
						name: "GPT-5.6 Sol",
					},
					{
						provider: "ollama",
						providerName: "ollama",
						id: "qwen3-coder:30b",
						name: "qwen3-coder:30b",
					},
				],
			});
			await view.flush();
			expect(view.captureCharFrame()).toContain("GPT-5.6 Sol · OpenAI Codex");
			view.mockInput.pressArrow("down");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({
				type: "configure",
				provider: "ollama",
				model: "qwen3-coder:30b",
			});
			await view.mockInput.typeText("/login ");
			view.mockInput.pressEnter();
			await view.flush();
			view.mockInput.pressEnter();
			await view.flush();
			store.getState().apply({
				type: "providers",
				providers: [
					{
						id: "openai-codex",
						name: "OpenAI Codex",
						authTypes: ["oauth"],
						configured: true,
					},
				],
			});
			await view.flush();
			view.mockInput.pressEnter();
			await view.flush();
			store.getState().apply({
				type: "auth-prompt",
				prompt: { id: "prompt-1", type: "text", message: "Name" },
			});
			await view.flush();
			view.mockInput.pressEscape();
			await view.flush();
			expect(sent.at(-1)).toEqual({ type: "auth-cancel" });
			expect(
				sent.some((command) => (command as { type: string }).type === "abort"),
			).toBe(false);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("picks fast-cycle models with Space and cycles them with Ctrl+P", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		const view = await createTestRenderer({
			width: 72,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			await view.renderOnce();
			store.getState().apply({
				type: "fast-cycle",
				entries: [
					{
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						thinkingLevel: "high",
					},
				],
			});
			await view.mockInput.typeText("/fast-cycle ");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({ type: "list-models" });
			store.getState().apply({
				type: "models",
				models: [
					{
						provider: "openai-codex",
						providerName: "OpenAI Codex",
						id: "gpt-5.6-sol",
						name: "GPT-5.6 Sol",
					},
					{
						provider: "anthropic",
						providerName: "Anthropic",
						id: "opus",
						name: "Opus",
					},
				],
			});
			await view.flush();
			expect(view.captureCharFrame()).toContain(
				"[x] GPT-5.6 Sol · OpenAI Codex · high",
			);
			expect(view.captureCharFrame()).toContain("[ ] Opus · Anthropic");
			view.mockInput.pressArrow("down");
			view.mockInput.pressKey(" ");
			await view.flush();
			expect(view.captureCharFrame()).toContain("[x] Opus · Anthropic");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({
				type: "set-fast-cycle",
				entries: [
					{
						provider: "openai-codex",
						model: "gpt-5.6-sol",
						thinkingLevel: "high",
					},
					{ provider: "anthropic", model: "opus" },
				],
			});
			view.mockInput.pressKey("p", { ctrl: true });
			await view.flush();
			expect(sent.at(-1)).toEqual({ type: "cycle-model" });
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
			await view.flush();
			let spans = view.captureSpans().lines.flatMap((line) => line.spans);
			expect(
				spans.find((span) => span.text === "▌")?.fg.equals(
					DIM,
				),
			).toBe(true);
			expect(
				spans.find((span) => span.text.includes("new direction"))?.bg.equals(
					USER_BACKGROUND,
				),
			).toBe(true);
			store.getState().apply({
				type: "command",
				id: id!,
				command: "steer",
				state: "started",
			});
			expect(store.getState().entries.at(-1)).toMatchObject({ pending: false });
			await view.flush();
			spans = view.captureSpans().lines.flatMap((line) => line.spans);
			expect(
				spans.find((span) => span.text === "▌")?.fg.equals(
					ACCENT,
				),
			).toBe(true);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});

	test("switches MCP servers off and on from the /mcp menu", async () => {
		const store = createTuiStore("session-1");
		const sent: unknown[] = [];
		const view = await createTestRenderer({
			width: 80,
			height: 20,
			kittyKeyboard: true,
		});
		const app = new TuiApp(view.renderer, store, async (command) => {
			sent.push(command);
		});
		try {
			await view.renderOnce();
			await view.mockInput.typeText("/mcp ");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({ type: "list-mcp-servers" });
			store.getState().apply({
				type: "mcp-servers",
				servers: [
					{
						name: "duckduckgo",
						transport: "stdio",
						enabled: true,
						connected: true,
						tools: 2,
						tokens: 702,
					},
					{
						name: "spokenly",
						transport: "streamable-http",
						enabled: true,
						connected: false,
						tools: 0,
						tokens: 0,
						error: "failed to connect: refused",
					},
				],
			});
			await view.flush();
			const frame = view.captureCharFrame();
			expect(frame).toContain("[x] duckduckgo · stdio · 2 tools · ~702 tokens");
			// A server that would not start says so rather than vanishing.
			expect(frame).toContain(
				"[x] spokenly · streamable-http · failed to connect: refused",
			);
			expect(frame).toContain("1/2 connected · ~702 tokens");

			view.mockInput.pressArrow("down");
			view.mockInput.pressKey(" ");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({
				type: "set-mcp-enabled",
				servers: ["duckduckgo"],
			});
			// The refreshed listing redraws the menu with the outcome of the toggle.
			store.getState().apply({
				type: "mcp-servers",
				servers: [
					{
						name: "duckduckgo",
						transport: "stdio",
						enabled: true,
						connected: true,
						tools: 2,
						tokens: 702,
					},
					{
						name: "spokenly",
						transport: "streamable-http",
						enabled: false,
						connected: false,
						tools: 0,
						tokens: 0,
					},
				],
			});
			await view.flush();
			expect(view.captureCharFrame()).toContain(
				"[ ] spokenly · streamable-http · off",
			);
		} finally {
			app.destroy();
			view.renderer.destroy();
		}
	});
});
