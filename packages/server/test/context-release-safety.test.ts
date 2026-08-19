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
	const dir = mkdtempSync(join(tmpdir(), "harnez-release-safety-"));
	paths.push(dir);
	const store = new SessionStore(join(dir, "state.sqlite"));
	const sessionId = store.create();
	const manager = new ContextManager(store);
	for (let index = 0; index < 12; index++)
		manager.record({
			id: `old-${index}`,
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: [{ type: "text", text: "x".repeat(2_000) }] },
			tokenCost: 1_000,
			lifecycle: "retained",
			projection: "full",
			reason: "release safety",
		});
	return { store, sessionId, manager };
}

test("fallback projection preserves bounded episode goals, anchors, and conclusions", async () => {
	const { store, sessionId, manager } = setup();
	const exploration = manager.startEpisode(sessionId, {
		name: "preserve the release goal",
		kind: "exploration",
	});
	manager.record({
		sessionId,
		kind: "pinned-note",
		payload: { role: "user", content: "anchor: never lose the migration invariant" },
		tokenCost: 10,
		lifecycle: "pinned",
		projection: "full",
		reason: "episode anchor",
		episodeId: exploration.id,
	});
	manager.endEpisode(sessionId, "conclusion: the migration invariant holds");
	manager.startEpisode(sessionId, { name: "continue bounded verification", kind: "exploration" });

	const prepared = await manager.prepareTurn({
		sessionId,
		taskId: "fallback",
		laneId: "main",
		fixedMessages: [],
		capabilityMessages: [],
		tools: [],
		budget: 8_000,
		signal: new AbortController().signal,
	});
	const text = JSON.stringify(prepared.messages);
	expect(prepared.usedFallback).toBe(true);
	expect(text).toContain("preserve the release goal");
	expect(text).toContain("continue bounded verification");
	expect(text).toContain("anchor: never lose the migration invariant");
	expect(text).toContain("conclusion: the migration invariant holds");
	// The source item remains byte-for-byte intact; only the provider projection is summarized.
	expect(store.contextItems(sessionId).some((item) => item.kind === "pinned-note")).toBe(true);
});

test("stale async compaction is discarded and safely replanned as fallback", async () => {
	const { store, sessionId, manager } = setup();
	const events: Record<string, unknown>[] = [];
	const observed = new ContextManager(store, (event) => events.push(event));
	let release!: () => void;
	const paused = new Promise<void>((resolve) => (release = resolve));
	let started!: () => void;
	const startedSignal = new Promise<void>((resolve) => (started = resolve));
	const pending = observed.prepareTurn({
		sessionId,
		taskId: "stale-plan",
		laneId: "main",
		fixedMessages: [],
		capabilityMessages: [],
		tools: [],
		budget: 12_000,
		signal: new AbortController().signal,
		compactor: async () => {
			started();
			await paused;
			return {
				memory: {
					milestone: "must be discarded",
					completedWork: ["stale"],
					strategies: [],
					environmentChanges: [],
					constraints: [],
					openQuestions: [],
					references: [],
				},
			};
		},
	});
	await startedSignal;
	manager.record({
		sessionId,
		kind: "user",
		payload: { role: "user", content: "concurrent exact input" },
		tokenCost: 10,
		lifecycle: "pinned",
		projection: "full",
		reason: "concurrent writer",
	});
	release();
	const prepared = await pending;
	expect(prepared.usedFallback).toBe(true);
	expect(JSON.stringify(prepared.messages)).toContain("concurrent exact input");
	expect(
		events.some(
			(event) =>
				event["type"] === "context.compaction.failed" &&
				event["stalePlan"] === true &&
				event["retries"] === 1,
		),
	).toBe(true);
	expect(store.contextItems(sessionId).filter((item) => item.nodeRole === "checkpoint")).toHaveLength(1);
});

test("normal provider assembly excludes child-only history", () => {
	const { store, sessionId, manager } = setup();
	const main = store.contextPath(sessionId, "main").at(-1);
	if (!main) throw new Error("missing main history");
	store.createLane({
		sessionId,
		name: "child",
		ownerTaskId: "child-task",
		fromItemId: main.id,
	});
	const child = store.appendContextAtHead(
		{
			id: "child-only",
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "CHILD-ONLY-SENTINEL" },
			tokenCost: 1,
			lifecycle: "active",
			projection: "full",
			reason: "child history",
			createdAt: new Date().toISOString(),
		},
		"child",
		0,
	);
	if ("status" in child) throw new Error("child append failed");
	const assembled = manager.assemble(sessionId, {
		budget: 80_000,
		target: 60_000,
		overheadTokens: 0,
	});
	expect(JSON.stringify(assembled.payloads)).not.toContain("CHILD-ONLY-SENTINEL");
});
