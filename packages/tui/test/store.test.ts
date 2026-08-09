import { describe, expect, test } from "bun:test";
import { createTuiStore } from "../src/store";

describe("TUI protocol store", () => {
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

	test("projects replayed reasoning, tool failures, status, and completion", () => {
		const store = createTuiStore("session");
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
		store.getState().apply({ type: "completed" });
		expect(store.getState().running).toBe(false);
		expect(store.getState().configuredStatus).toBe(
			"configured openai-codex/gpt-5.6-sol",
		);
		expect(store.getState().entries.map((entry) => entry.kind)).toEqual([
			"status",
			"status",
			"reasoning",
			"tool-result",
			"completed",
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
});
