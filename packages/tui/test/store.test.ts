import { describe, expect, test } from "bun:test";
import { createTuiStore } from "../src/store";

describe("TUI protocol store", () => {
	function createStoreWithStatus(showStatus: boolean) {
		const previous = process.env["HARNESS_SHOW_STATUS"];
		if (showStatus) process.env["HARNESS_SHOW_STATUS"] = "1";
		else delete process.env["HARNESS_SHOW_STATUS"];
		const store = createTuiStore("session");
		if (previous === undefined) delete process.env["HARNESS_SHOW_STATUS"];
		else process.env["HARNESS_SHOW_STATUS"] = previous;
		return store;
	}

	test("coalesces only the active assistant tail", () => {
		const store = createTuiStore("session");
		store.getState().apply({ type: "assistant-delta", text: "hel" });
		store.getState().apply({ type: "assistant-delta", text: "lo" });
		store.getState().apply({
			type: "tool-call",
			id: "read-1",
			name: "read",
			input: { path: "note.txt" },
		});
		store.getState().apply({ type: "assistant-delta", text: "done" });
		expect(
			store.getState().entries.map((entry) => [entry.kind, entry.text]),
		).toEqual([
			["assistant", "hello"],
			["tool-call", 'read {"path":"note.txt"}'],
			["assistant", "done"],
		]);
	});

	test("hides runtime rows by default and shows the completion duration", () => {
		const store = createStoreWithStatus(false);
		store
			.getState()
			.apply({ type: "status", text: "configured openai-codex/gpt-5.6-sol" });
		store.getState().apply({ type: "status", text: "running" });
		store
			.getState()
			.apply({ type: "assistant-reasoning-delta", text: "checking" });
		store.getState().apply({
			type: "tool-result",
			id: "edit-1",
			name: "edit",
			output: "failed",
			isError: true,
		});
		store.getState().apply({
			type: "usage",
			input: 176,
			output: 11,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 187,
		});
		store.getState().apply({ type: "completed", durationMs: 257_000 });
		expect(store.getState().running).toBe(false);
		expect(store.getState().configuredStatus).toBe(
			"configured openai-codex/gpt-5.6-sol",
		);
		expect(store.getState().entries.map((entry) => entry.kind)).toEqual([
			"reasoning",
			"tool-result",
			"completed",
		]);
		expect(store.getState().entries.at(-1)?.text).toBe("✶ Noodled for 4m 17s");
	});

	test("shows runtime rows when HARNESS_SHOW_STATUS is enabled", () => {
		const store = createStoreWithStatus(true);
		store.getState().apply({ type: "status", text: "running" });
		store.getState().apply({
			type: "usage",
			input: 176,
			output: 11,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 187,
		});
		expect(store.getState().entries.map((entry) => entry.kind)).toEqual([
			"status",
			"usage",
		]);
	});

	test("tracks steering acceptance and follow-up lifecycle by command id", () => {
		const store = createTuiStore("session");
		store.getState().addSteering("steer-1", "new direction");
		store.getState().addFollowUp("follow-1", "after this");
		expect(store.getState().entries.at(-1)).toMatchObject({
			id: "steer-1",
			pending: true,
		});
		expect(store.getState().followUps).toEqual([
			{ id: "follow-1", text: "after this", sending: false },
		]);
		store.getState().apply({
			type: "command",
			id: "steer-1",
			command: "steer",
			state: "started",
		});
		store.getState().apply({
			type: "command",
			id: "follow-1",
			command: "follow-up",
			state: "started",
		});
		expect(store.getState().entries.at(-1)).toMatchObject({ pending: false });
		expect(store.getState().followUps.at(-1)).toMatchObject({ sending: true });
		store.getState().apply({
			type: "command",
			id: "follow-1",
			command: "follow-up",
			state: "finished",
		});
		expect(store.getState().followUps).toEqual([]);
		store.getState().addSteering("steer-2", "superseded direction");
		store.getState().apply({
			type: "command",
			id: "steer-2",
			command: "steer",
			state: "replaced",
		});
		expect(
			store.getState().entries.some((entry) => entry.id === "steer-2"),
		).toBe(false);
	});

	test("projects catalog and authentication events into transient wizard state", () => {
		const store = createTuiStore("session");
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
		expect(store.getState().wizard).toMatchObject({ kind: "providers" });
		store.getState().apply({
			type: "auth-prompt",
			prompt: { id: "prompt-1", type: "secret", message: "API key" },
		});
		expect(store.getState().wizard).toMatchObject({
			kind: "prompt",
			prompt: { id: "prompt-1", type: "secret" },
		});
		expect(store.getState().entries).toEqual([]);
		store.getState().apply({ type: "error", message: "login failed" });
		expect(store.getState().wizard).toEqual({ kind: "cancelled" });
		store.getState().clearWizard();
		expect(store.getState().wizard).toEqual({ kind: "idle" });
	});
});
