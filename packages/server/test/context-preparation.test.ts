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

function setup(historyItems = 12) {
	const dir = mkdtempSync(join(tmpdir(), "harnez-prepare-"));
	paths.push(dir);
	const store = new SessionStore(join(dir, "state.sqlite"));
	const sessionId = store.create();
	const manager = new ContextManager(store);
	for (let index = 0; index < historyItems; index++)
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

test("prefix telemetry aliases include the resolved system prompt", async () => {
	const { sessionId, store } = setup();
	const firstEvents: Record<string, unknown>[] = [];
	const first = new ContextManager(store, (event) => firstEvents.push(event));
	await first.prepareTurn({
		sessionId,
		taskId: "prompt-alias",
		laneId: "main",
		fixedMessages: [],
		capabilityMessages: [],
		tools: [],
		systemPrompt: "system one",
		budget: 12_000,
		signal: new AbortController().signal,
	});
	const secondEvents: Record<string, unknown>[] = [];
	const second = new ContextManager(store, (event) => secondEvents.push(event));
	await second.prepareTurn({
		sessionId,
		taskId: "prompt-alias",
		laneId: "main",
		fixedMessages: [],
		capabilityMessages: [],
		tools: [],
		systemPrompt: "system two",
		budget: 12_000,
		signal: new AbortController().signal,
	});
	const alias = (events: Record<string, unknown>[]) =>
		events.find((event) => event["type"] === "context.prepare")?.["prefixAlias"];
	expect(alias(firstEvents)).toBeString();
	expect(alias(firstEvents)).not.toBe(alias(secondEvents));
});

test("compaction telemetry reports bounded metadata without summary content", async () => {
	const { sessionId, store } = setup();
	const events: Record<string, unknown>[] = [];
	const manager = new ContextManager(store, (event) => events.push(event));
	await manager.prepareTurn({
		sessionId,
		taskId: "telemetry",
		laneId: "main",
		fixedMessages: [],
		capabilityMessages: [],
		tools: [],
		provider: "test-provider",
		model: "test-model",
		budget: 12_000,
		signal: new AbortController().signal,
		compactor: async () => ({
			memory,
			provider: "test-provider",
			model: "test-model",
			inputTokens: 800,
			outputTokens: 120,
			cacheReadTokens: 40,
			cacheWriteTokens: 20,
			retries: 1,
		}),
	});
	const completed = events.find(
		(event) => event["type"] === "context.compaction.completed",
	);
	expect(completed).toMatchObject({
		lane: "main",
		origin: "main",
		trigger: "automatic-llm",
		provider: "test-provider",
		model: "test-model",
		inputTokens: 800,
		outputTokens: 120,
		cacheReadTokens: 40,
		cacheWriteTokens: 20,
		retries: 1,
		stalePlan: false,
	});
	expect(completed?.["sourceCount"]).toBeGreaterThan(0);
	expect(completed?.["sourceTokens"]).toBeGreaterThan(0);
	expect(completed?.["beforeTokens"]).toBeGreaterThan(
		completed?.["afterTokens"] as number,
	);
	expect(completed).not.toHaveProperty("memory");
	expect(completed).not.toHaveProperty("milestone");
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
		payload: { role: "toolResult", content: [{ type: "text", text: "x".repeat(80_000) }] },
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

test("a large active turn that fits the model budget is accepted", async () => {
	const { sessionId, manager } = setup(0);
	manager.record({
		sessionId,
		kind: "user",
		payload: { role: "user", content: "x".repeat(488_000) },
		tokenCost: 122_000,
		lifecycle: "pinned",
		reason: "active turn",
	});

	const prepared = await manager.prepareTurn({
		sessionId,
		taskId: "task-1",
		laneId: "main",
		fixedMessages: [],
		capabilityMessages: [],
		tools: [],
		budget: 144_000,
		overheadTokens: 12_000,
		signal: new AbortController().signal,
		compactor: async () => ({ memory }),
	});

	expect(prepared.estimatedTokens).toBeLessThanOrEqual(144_000);
	expect(prepared.messages).toContainEqual({
		role: "user",
		content: "x".repeat(488_000),
	});
});

test("externalizes a user turn larger than the model window", async () => {
	const { store, sessionId, manager } = setup(0);
	const text = `BEGIN\n${"x".repeat(80_000)}\nMIDDLE\n${"y".repeat(80_000)}\nEND`;
	const prepared = await manager.prepareTurn({
		sessionId,
		taskId: "task-1",
		laneId: "main",
		fixedMessages: [],
		capabilityMessages: [],
		tools: [],
		budget: 12_000,
		signal: new AbortController().signal,
		pendingInput: [{
			sessionId,
			kind: "user",
			payload: { role: "user", content: text },
			tokenCost: Math.ceil(text.length / 4),
			lifecycle: "pinned",
			reason: "user-authored message",
		}],
	});
	const user = store.contextItems(sessionId).find((item) => item.kind === "user");
	expect(user?.payload).toEqual({ role: "user", content: text });
	expect(user).toMatchObject({ projection: "reference" });
	expect(user?.source?.observationId).toBe(user?.id);
	expect(prepared.estimatedTokens).toBeLessThanOrEqual(12_000);
	expect(JSON.stringify(prepared.messages)).toContain("authoritative_source:");
	expect(JSON.stringify(prepared.messages)).toContain("unread_ranges:");
});
