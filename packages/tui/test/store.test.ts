import { describe, expect, test } from "bun:test";
import { createTuiStore } from "../src/store";
import { displayUserInput } from "../../shared/src/protocol";

describe("TUI protocol store", () => {
	test("announces a new subagent once", () => {
		const store = createTuiStore("session-1");
		const agent = {
			id: "agent-1",
			profile: "explore",
			description: "Inspect package version",
			state: "queued" as const,
		};
		store.getState().apply({ type: "subagent-state", agent });
		store.getState().apply({
			type: "subagent-state",
			agent: { ...agent, state: "running" },
		});

		expect(
			store
				.getState()
				.entries.filter((entry) => entry.kind === "agent"),
		).toEqual([
			{
				kind: "agent",
				text: "◆ Explore(Inspect package version)\n  ╰ Backgrounded agent (↓ to manage · ← for all agents)",
			},
		]);
	});
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
		store.getState().apply({
			type: "tool-result",
			id: "read-1",
			name: "read",
			output: "note contents",
		});
		store.getState().apply({ type: "assistant-delta", text: "done" });
		expect(
			store
				.getState()
				.entries.map((entry) => [entry.kind, entry.text, entry.detail]),
		).toEqual([
			["assistant", "hello", undefined],
			["tool-call", "read", "note contents"],
			["assistant", "done", undefined],
		]);
	});

	test("replays user messages and deduplicates their optimistic row", () => {
		const store = createTuiStore("session");
		store.getState().apply({ type: "user", text: "replayed" });
		store.getState().addSteering("user-1", "optimistic");
		store
			.getState()
			.apply({ type: "user", id: "user-1", text: "optimistic" });

		expect(
			store
				.getState()
				.entries.filter((entry) => entry.kind === "user")
				.map(({ id, text, pending }) => ({ id, text, pending })),
		).toEqual([
			{ id: undefined, text: "replayed", pending: undefined },
			{ id: "user-1", text: "optimistic", pending: false },
		]);
	});

	test("keeps optimistic and replayed image rows as placeholders only", () => {
		const store = createTuiStore("session");
		const images = [
			{ id: "one", mimeType: "image/png" as const, data: "c2VjcmV0" },
			{ id: "two", mimeType: "image/png" as const, data: "c2VjcmV0Mg==" },
		];
		const text = displayUserInput("draft [Image #99]", images);
		store.getState().addSteering("user-1", text);
		store.getState().apply({ type: "user", id: "user-1", text });
		store.getState().apply({ type: "user", text: displayUserInput("", images) });
		const rows = store.getState().entries.filter((entry) => entry.kind === "user");
		expect(rows.map((entry) => entry.text)).toEqual([
			"draft\n\n[Image #1]\n[Image #2]",
			"[Image #1]\n[Image #2]",
		]);
		expect(rows.every((entry) => !entry.text.includes("c2VjcmV0"))).toBe(true);
	});

	test("hides runtime rows by default and shows the completion duration", () => {
		const store = createStoreWithStatus(false);
		store
			.getState()
			.apply({
				type: "model-config",
				config: { provider: "openai-codex", model: "gpt-5.6-sol" },
			});
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
		store.getState().apply({
			type: "completed",
			durationMs: 257_000,
			modelDurationMs: 211_000,
			toolDurationMs: 38_000,
		});
		expect(store.getState().running).toBe(false);
		expect(store.getState().modelConfig).toEqual({
			provider: "openai-codex",
			model: "gpt-5.6-sol",
		});
		expect(store.getState().entries.map((entry) => entry.kind)).toEqual([
			"reasoning",
			"tool-result",
			"completed",
		]);
		expect(store.getState().entries.at(-1)?.text).toBe(
			"✶ Noodled for 4m 17s · model 3m 31s · tools 38s",
		);
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
			costUsd: 0.0012,
		});
		store.getState().apply({
			type: "usage",
			input: 200,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 220,
			costUsd: 0.0023,
		});
		store.getState().apply({ type: "completed", durationMs: 12_000 });
		expect(store.getState().entries.map((entry) => entry.kind)).toEqual([
			"status",
			"usage",
			"usage",
			"completed",
		]);
		expect(store.getState().entries.slice(-3).map((entry) => entry.text)).toEqual([
			"in 176 · out 11 · total 187",
			"in 200 · out 20 · total 220",
			"✶ Noodled for 12s (0.0035$)",
		]);
		expect(store.getState().sessionCostUsd).toBeCloseTo(0.0035);
		expect(store.getState().turnCostUsd).toBeUndefined();
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
		store.getState().addSteering("steer-3", "cancelled direction");
		store.getState().apply({
			type: "command",
			id: "steer-3",
			command: "steer",
			state: "cancelled",
		});
		expect(
			store.getState().entries.some((entry) => entry.id === "steer-3"),
		).toBe(false);
	});

	test("tracks blocked queued tasks and removes cancelled ones", () => {
		const store = createTuiStore("session");
		store.getState().apply({
			type: "task-state",
			taskId: "queued-1",
			state: "blocked",
		});
		expect(store.getState().followUps).toEqual([
			{ id: "queued-1", text: "queued task", sending: false, blocked: true },
		]);
		expect(store.getState().blockedQueueId).toBe("queued-1");
		store.getState().apply({
			type: "command",
			id: "queued-1",
			command: "follow-up",
			state: "cancelled",
		});
		expect(store.getState().followUps).toEqual([]);
		expect(store.getState().blockedQueueId).toBeUndefined();
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
	test("keeps context maintenance out of the transcript", () => {
		const store = createTuiStore("session");
		store.getState().apply({
			type: "context-status",
			liveTokens: 26_000,
			historyTokens: 180_000,
			parkedObservations: 140,
			budget: 160_000,
			target: 120_000,
		});
		store.getState().apply({
			type: "context-compaction",
			evictedCount: 12,
			tokensBefore: 38_400,
			tokensAfter: 4_100,
			episodesArchived: 1,
		});
		store.getState().apply({
			type: "context-compaction",
			trigger: "explicit",
			milestone: "tests complete",
			evictedCount: 2,
			tokensBefore: 2_000,
			tokensAfter: 500,
			episodesArchived: 0,
		});
		expect(store.getState().entries).toEqual([]);
	});

	test("shows an oversized request without exposing context accounting", () => {
		const store = createTuiStore("session");
		store.getState().apply({
			type: "error",
			message:
				"This request is too large for the selected model. Try a smaller request or another model.",
		});
		expect(store.getState().running).toBe(false);
		const last = store.getState().entries.at(-1);
		expect(last?.kind).toBe("error");
		expect(last?.text).not.toMatch(/token|budget/i);
	});
});
