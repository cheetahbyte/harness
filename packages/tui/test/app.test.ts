import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { TuiApp } from "../src/app";
import { createTuiStore } from "../src/store";

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
			expect(view.captureCharFrame()).toContain("gpt-5.6-sol (openai-codex)");
			expect(view.captureCharFrame()).toContain("~/project");
			expect(view.captureCharFrame()).toContain("Read 1 file");
			expect(view.captureCharFrame()).toContain(
				`╰ hello ${"x".repeat(44)}...`,
			);
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

	test("groups consecutive tool calls by operation", async () => {
		const store = createTuiStore("session-1");
		for (const [id, name] of [
			["bash-1", "bash"],
			["read-1", "read"],
			["read-2", "read"],
		] as const) {
			store.getState().apply({ type: "tool-call", id, name, input: {} });
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
			expect(frame).toContain("╰ bash-1 output");
			expect(frame).toContain("╰ read-2 output");
			expect(frame.match(/Ran|Read/g)).toHaveLength(1);
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
			const accent = RGBA.fromHex("#89b4fa");
			expect(spans.find((span) => span.text === "▎")?.fg.equals(accent)).toBe(true);
			expect(
				spans.find((span) => span.text === "/codebase-design")?.fg.equals(accent),
			).toBe(true);
			expect(
				spans.find((span) => span.text.includes("Use"))?.fg.equals(
					RGBA.fromHex("#cdd6f4"),
				),
			).toBe(true);
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
			await view.mockInput.typeText("/");
			await view.flush();
			const frame = view.captureCharFrame();
			expect(frame).toContain("/s3");
			expect(frame).not.toContain("/s4");
			expect(frame).not.toContain("suggestion row");
			for (let index = 0; index < 5; index++) view.mockInput.pressArrow("down");
			await view.flush();
			expect(view.captureCharFrame()).toContain("/s4");
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
			await view.mockInput.typeText("/");
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
			expect(opened).toEqual([["open", "https://example.com/authorize"]]);
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
				],
			});
			await view.flush();
			expect(view.captureCharFrame()).toContain("GPT-5.6 Sol · OpenAI Codex");
			view.mockInput.pressEnter();
			await view.flush();
			expect(sent.at(-1)).toEqual({
				type: "configure",
				provider: "openai-codex",
				model: "gpt-5.6-sol",
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
