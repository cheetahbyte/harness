import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContextManager } from "../src/context/manager";
import type { SubagentResult } from "../src/context/types";
import { SessionStore } from "../src/sessions/store";

const paths: string[] = [];

afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const memory = {
	milestone: "500-turn release soak",
	completedWork: ["retained the durable session history"],
	strategies: [],
	environmentChanges: [],
	constraints: [],
	openQuestions: [],
	references: [],
};

const handoff: SubagentResult = {
	status: "completed",
	summary: "## Findings\n\nChild lane completed.\n\n## Verification\n\nRelease soak.",
};

function assertRawPayloads(store: SessionStore, raw: Map<string, string>): void {
	for (const [id, expected] of raw) {
		const item = store.contextItem(id);
		expect(item).toBeDefined();
		expect(JSON.stringify(item?.payload)).toBe(expected);
	}
}

test("survives 500 mixed turns, compaction, recovery, and lane handoff", async () => {
	const dir = mkdtempSync(join(tmpdir(), "harnez-long-session-"));
	paths.push(dir);
	const database = join(dir, "state.sqlite");
	let store = new SessionStore(database);
	const sessionId = store.create();
	let manager = new ContextManager(store);
	const raw = new Map<string, string>();
	let llmCompactions = 0;
	let explorationId = "";

	for (let turn = 0; turn < 500; turn++) {
		if (turn === 100)
			explorationId = manager.startEpisode(sessionId, {
				name: "long-session exploration",
				kind: "exploration",
			}).id;
		if (turn === 110)
			manager.endEpisode(sessionId, "The release soak remains bounded.");
		if (turn === 111)
			manager.startEpisode(sessionId, {
				name: "verify bounded continuation",
				kind: "action",
				dependencies: [explorationId],
			});
		if (turn === 115) manager.endEpisode(sessionId);
		const groupId = `turn-${turn}`;
		const user = {
			role: "user",
			content: `request-${turn}: preserve this exact request`,
		};
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: `answer-${turn}: exact response` }],
		};
		const tool = {
			role: "toolResult",
			content: [{ type: "text", text: `tool-${turn}: exact result` }],
		};
		for (const [id, kind, payload, lifecycle] of [
			[`user-${turn}`, "user", user, "pinned"],
			[`assistant-${turn}`, "assistant", assistant, "active"],
			[`tool-${turn}`, "tool-result", tool, "active"],
		] as const) {
			manager.record({
				id,
				sessionId,
				kind,
				payload,
				tokenCost: 12,
				lifecycle,
				projection: "full",
				reason: "long-session soak",
				groupId,
			});
			raw.set(id, JSON.stringify(payload));
		}
		manager.completeGroup(sessionId, groupId);

		if (turn % 37 === 0) {
			const id = `observation-${turn}`;
			const text = `observation-${turn}: exact bytes \u0000 ${"x".repeat(32)}`;
			manager.recordObservation(sessionId, text, { observationId: id });
			raw.set(id, JSON.stringify(text));
			expect(manager.recall(sessionId, `observation://${id}`).text).toBe(text);
		}

		if (turn === 3)
			manager.pin(sessionId, "decision", "keep the exact release behavior", {
				budget: 2_000,
				target: 1_200,
			});

		if (turn % 25 === 24)
			await manager.prepareTurn({
				sessionId,
				taskId: `soak-${turn}`,
				laneId: "main",
				fixedMessages: [],
				capabilityMessages: [],
				tools: [],
				provider: "soak-provider",
				model: "soak-model",
				budget: 16_000,
				signal: new AbortController().signal,
				compactor: async () => {
					llmCompactions++;
					return {
						memory,
						provider: "soak-provider",
						model: "soak-model",
						inputTokens: 100,
						outputTokens: 20,
						cacheReadTokens: 0,
						cacheWriteTokens: 0,
						retries: 0,
					};
				},
			});

		if (turn === 150 || turn === 325) {
			assertRawPayloads(store, raw);
			store.db.close();
			store = new SessionStore(database);
			manager = new ContextManager(store);
			assertRawPayloads(store, raw);
		}
	}
	expect(llmCompactions).toBeGreaterThan(0);
	expect(manager.episodes(sessionId)).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: "long-session exploration",
				state: "completed",
			}),
			expect.objectContaining({
				name: "verify bounded continuation",
				state: "completed",
			}),
		]),
	);

	// Explicit condensation is a second, user-directed compaction path.
	for (let index = 0; index < 12; index++) {
		const id = `explicit-${index}`;
		const payload = { role: "toolResult", content: `explicit-${index}` };
		manager.record({
			id,
			sessionId,
			kind: "tool-result",
			payload,
			tokenCost: 80,
			lifecycle: "retained",
			projection: "full",
			reason: "explicit condensation input",
			groupId: `explicit-${index}`,
		});
		raw.set(id, JSON.stringify(payload));
	}
	expect(manager.condense(sessionId, memory).noOp).toBe(false);

	// A provider context-length response gets a durable deterministic checkpoint.
	const overflowPayload = {
		role: "user",
		content: "provider overflow recovery",
	};
	manager.record({
		id: "provider-overflow",
		sessionId,
		kind: "user",
		payload: overflowPayload,
		tokenCost: 10,
		lifecycle: "pinned",
		projection: "full",
		reason: "provider overflow",
	});
	raw.set("provider-overflow", JSON.stringify(overflowPayload));
	manager.recoverProviderOverflow(sessionId);

	// No LLM is available here: the same history must still make progress.
	for (let index = 0; index < 50; index++) {
		const id = `fallback-${index}`;
		const payload = {
			role: "toolResult",
			content: `fallback-${index} ${"x".repeat(400)}`,
		};
		manager.record({
			id,
			sessionId,
			kind: "tool-result",
			payload,
			tokenCost: 100,
			lifecycle: "retained",
			projection: "full",
			reason: "deterministic fallback input",
			groupId: `fallback-${index}`,
		});
		raw.set(id, JSON.stringify(payload));
	}
	manager.record({
		id: "fallback-current-turn",
		sessionId,
		kind: "user",
		payload: { role: "user", content: "fallback current turn" },
		tokenCost: 10,
		lifecycle: "pinned",
		projection: "full",
		reason: "deterministic fallback current turn",
	});
	raw.set(
		"fallback-current-turn",
		JSON.stringify({ role: "user", content: "fallback current turn" }),
	);
	await expect(
		manager.prepareTurn({
			sessionId,
			taskId: "deterministic-fallback",
			laneId: "main",
			fixedMessages: [],
			capabilityMessages: [],
			tools: [],
			budget: 4_000,
			signal: new AbortController().signal,
		}),
	).resolves.toMatchObject({ usedFallback: true });

	const mainHead = store.lane(sessionId)?.headItemId;
	expect(mainHead).toBeDefined();
	const child = manager.forkLane({
		sessionId,
		name: "release-child",
		ownerTaskId: "release-child-task",
		fromItemId: mainHead!,
	});
	expect(child.state).toBe("active");
	manager.finishTask({
		sessionId,
		taskId: "release-child-task",
		laneId: "release-child",
		status: "completed",
		handoff,
	});
	expect(store.contextItem("handoff-release-child-task")?.payload).toEqual(handoff);
	expect(store.lane(sessionId, "release-child")?.state).toBe("completed");

	assertRawPayloads(store, raw);
	expect(() => manager.inspect(sessionId, { budget: 1_000 })).not.toThrow();
	store.db.close();
}, 30_000);
