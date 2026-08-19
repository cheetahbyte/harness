import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextManager } from "../src/context/manager";
import { SessionStore } from "../src/sessions/store";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "harnez-prepare-"));
	paths.push(dir);
	const store = new SessionStore(join(dir, "state.sqlite"));
	const sessionId = store.create();
	const manager = new ContextManager(store);
	for (let index = 0; index < 12; index++)
		manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: [{ type: "text", text: "x".repeat(2_000) }] },
			tokenCost: 1_000,
			lifecycle: "retained",
			projection: "full",
			reason: "old turn",
			groupId: `old-${index}`,
		});
	return { store, sessionId, manager };
}

const memory = {
	milestone: "history condensed",
	completedWork: ["kept the relevant outcome"],
	strategies: [],
	environmentChanges: [],
	constraints: [],
	openQuestions: [],
	references: [],
};

test("preparation commits LLM memory and pending input in one lane update", async () => {
	const { store, sessionId, manager } = setup();
	let calls = 0;
	const prepared = await manager.prepareTurn({
		sessionId,
		taskId: "task-1",
		laneId: "main",
		fixedMessages: [],
		capabilityMessages: [],
		tools: [],
		budget: 12_000,
		signal: new AbortController().signal,
		compactor: async () => {
			calls++;
			return { memory };
		},
		pendingInput: [
			{
				sessionId,
				kind: "user",
				payload: { role: "user", content: "next step" },
				tokenCost: 3,
				lifecycle: "pinned",
				reason: "pending",
			},
		],
	});
	const items = store.contextItems(sessionId);
	const checkpoint = items.findLast((item) => item.nodeRole === "checkpoint");
	const pending = items.at(-1);
	expect(calls).toBe(1);
	expect(prepared.usedFallback).toBe(false);
	expect((checkpoint?.payload as { representation?: { kind?: string } }).representation?.kind).toBe("condensation");
	expect(pending?.kind).toBe("user");
	expect(pending?.parentId).toBe(checkpoint?.id);
});

test("abort after summarization commits neither checkpoint nor pending input", async () => {
	const { store, sessionId, manager } = setup();
	const controller = new AbortController();
	const before = store.contextItems(sessionId).length;
	await expect(
		manager.prepareTurn({
			sessionId,
			taskId: "task-1",
			laneId: "main",
			fixedMessages: [],
			capabilityMessages: [],
			tools: [],
			budget: 12_000,
			signal: controller.signal,
			compactor: async () => {
				controller.abort();
				return { memory };
			},
			pendingInput: [
				{
					sessionId,
					kind: "user",
					payload: { role: "user", content: "do not commit" },
					tokenCost: 3,
					lifecycle: "pinned",
					reason: "pending",
				},
			],
		}),
	).rejects.toHaveProperty("name", "AbortError");
	expect(store.contextItems(sessionId)).toHaveLength(before);
});

test("pending append failure rolls back the checkpoint", async () => {
	const { store, sessionId, manager } = setup();
	const before = store.contextItems(sessionId).length;
	const append = store.appendContextAtHead.bind(store);
	store.appendContextAtHead = (...args) => {
		if (args[0].kind === "user") throw new Error("pending write failed");
		return append(...args);
	};
	await expect(
		manager.prepareTurn({
			sessionId,
			taskId: "task-1",
			laneId: "main",
			fixedMessages: [],
			capabilityMessages: [],
			tools: [],
			budget: 12_000,
			signal: new AbortController().signal,
			compactor: async () => ({ memory }),
			pendingInput: [
				{
					sessionId,
					kind: "user",
					payload: { role: "user", content: "rollback" },
					tokenCost: 3,
					lifecycle: "pinned",
					reason: "pending",
				},
			],
		}),
	).rejects.toThrow("pending write failed");
	expect(store.contextItems(sessionId)).toHaveLength(before);
});

test("an oversized active turn is rejected before checkpointing", async () => {
	const { store, sessionId, manager } = setup();
	manager.record({
		sessionId,
		kind: "user",
		payload: { role: "user", content: "active turn" },
		tokenCost: 3,
		lifecycle: "pinned",
		reason: "active turn",
	});
	manager.record({
		sessionId,
		kind: "tool-result",
		payload: { role: "toolResult", content: [{ type: "text", text: "x".repeat(40_000) }] },
		tokenCost: 20_000,
		lifecycle: "retained",
		reason: "active tool result",
	});
	const before = store.contextItems(sessionId).length;

	await expect(
		manager.prepareTurn({
			sessionId,
			taskId: "task-1",
			laneId: "main",
			fixedMessages: [],
			capabilityMessages: [],
			tools: [],
			budget: 12_000,
			signal: new AbortController().signal,
			compactor: async () => ({ memory }),
		}),
	).rejects.toMatchObject({ code: "INPUT_TOO_LARGE" });
	expect(store.contextItems(sessionId)).toHaveLength(before);
});
