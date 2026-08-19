import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewContextItem } from "../src/context/types";
import { ContextManager } from "../src/context/manager";
import { SessionStore } from "../src/sessions/store";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function store(): SessionStore {
	const dir = mkdtempSync(join(tmpdir(), "harnez-context-lanes-"));
	const path = join(dir, "state.sqlite");
	paths.push(dir);
	return new SessionStore(path);
}

function input(sessionId: string, id: string, payload = id): NewContextItem {
	return {
		id,
		sessionId,
		kind: "assistant",
		payload: { role: "assistant", content: payload },
		tokenCost: 1,
		lifecycle: "active",
		projection: "full",
		reason: "test",
		createdAt: "2026-08-19T00:00:00.000Z",
	};
}

describe("persistent context lanes", () => {
	test("claims main once and uses revision CAS at the head", () => {
		const sessions = store();
		const sessionId = sessions.create();
		expect(sessions.claimMainLane(sessionId, "task-a")).toBe(true);
		expect(sessions.claimMainLane(sessionId, "task-a")).toBe(true);
		expect(sessions.claimMainLane(sessionId, "task-b")).toBe(false);

		const first = sessions.appendContextAtHead(input(sessionId, "first"), "main", 0);
		expect("status" in first).toBe(false);
		if ("status" in first) return;
		expect(first.parentId).toBeUndefined();
		expect(sessions.appendContextAtHead(input(sessionId, "second"), "main", 0)).toEqual({ status: "stale" });
		expect(sessions.appendContextAtHead(input(sessionId, "first"), "main", 0)).toEqual(first);
		expect(() => sessions.appendContextAtHead({ ...input(sessionId, "first"), payload: { content: "changed" } }, "main", 0)).toThrow("existing content");
		expect(sessions.contextPath(sessionId, "main").map(({ id }) => id)).toEqual(["first"]);
	});

	test("preserves origin lane and supports child forks without copying history", () => {
		const sessions = store();
		const sessionId = sessions.create();
		const first = sessions.appendContextAtHead(input(sessionId, "first"), "main", 0);
		if ("status" in first) throw new Error("first append failed");
		const child = sessions.createLane({
			sessionId,
			name: "exploration",
			ownerTaskId: "task-child",
			fromItemId: first.id,
		});
		expect(child.state).toBe("active");
		const next = sessions.appendContextAtHead(input(sessionId, "child"), "exploration", 0);
		if ("status" in next) throw new Error("child append failed");
		expect(next.parentId).toBe(first.id);
		expect(next.originLane).toBe("exploration");
		expect(sessions.contextPath(sessionId, "exploration").map(({ id }) => id)).toEqual(["first", "child"]);
		expect(
			sessions.createLane({
				sessionId,
				name: "second-child",
				ownerTaskId: "task-second",
				fromItemId: first.id,
			}).forkedFromItemId,
		).toBe(first.id);
		expect(() =>
			sessions.createLane({
				sessionId,
				name: "nested-child",
				ownerTaskId: "task-nested",
				fromItemId: next.id,
			}),
		).toThrow("fork from main");
	});

	test("rejects invalid parents and checkpoint metadata without advancing a head", () => {
		const sessions = store();
		const firstSession = sessions.create();
		const secondSession = sessions.create();
		const first = sessions.appendContextAtHead(input(firstSession, "first"), "main", 0);
		if ("status" in first) throw new Error("first append failed");
		expect(() => sessions.appendContextAtHead({ ...input(secondSession, "cross"), parentId: first.id }, "main", 0)).toThrow("another session");
		expect(() => sessions.appendContextAtHead({ ...input(firstSession, "checkpoint"), nodeRole: "checkpoint" }, "main", 1)).toThrow("checkpoint metadata required");
		expect(sessions.lane(firstSession)?.revision).toBe(1);
		expect(sessions.appendContextAtHead(input(firstSession, "unknown"), "missing", 0)).toEqual({ status: "stale" });
	});

	test("rejects duplicate logical checkpoints and detects a persisted cycle", () => {
		const sessions = store();
		const sessionId = sessions.create();
		const checkpoint = sessions.appendContextAtHead({
			...input(sessionId, "checkpoint"),
			nodeRole: "checkpoint",
			sourceDigest: "source",
			policyVersion: 1,
		}, "main", 0);
		if ("status" in checkpoint) throw new Error("checkpoint append failed");
		expect(() => sessions.appendContextAtHead({
			...input(sessionId, "checkpoint-duplicate"),
			nodeRole: "checkpoint",
			sourceDigest: "source",
			policyVersion: 1,
		}, "main", 1)).toThrow("UNIQUE");
		expect(sessions.lane(sessionId)?.revision).toBe(1);
		sessions.db.query("UPDATE context_items SET parent_id = id WHERE id = ?").run(checkpoint.id);
		expect(() => sessions.contextPath(sessionId)).toThrow("cycle");
	});

	test("recovers owners, episodes, and task conflicts idempotently", () => {
		const sessions = store();
		const sessionId = sessions.create();
		const manager = new ContextManager(sessions);
		sessions.startContextTask(sessionId, "main-task", "2026-08-19T00:00:00.000Z");
		sessions.db
			.query(
				"UPDATE tasks SET state = 'terminal', status = 'completed' WHERE id = 'main-task'",
			)
			.run();
		expect(sessions.recoverLanes()).toEqual({
			repaired: 1,
			abandoned: 0,
			failed: 0,
		});
		sessions.db
			.query(
				"UPDATE context_lanes SET state = 'active', owner_task_id = 'missing-main' WHERE session_id = ? AND name = 'main'",
			)
			.run(sessionId);
		expect(sessions.recoverLanes()).toEqual({
			repaired: 1,
			abandoned: 0,
			failed: 0,
		});

		const episode = manager.startEpisode(sessionId, {
			name: "orphaned exploration",
			kind: "exploration",
		});
		const first = sessions.appendContextAtHead(input(sessionId, "first"), "main", 0);
		if ("status" in first) throw new Error("append failed");
		sessions.db
			.query("UPDATE context_items SET episode_id = ? WHERE id = ?")
			.run(episode.id, first.id);
		sessions.createLane({ sessionId, name: "child", ownerTaskId: "missing", fromItemId: first.id });
		expect(sessions.recoverLanes()).toEqual({ repaired: 0, abandoned: 1, failed: 0 });
		expect(sessions.recoverLanes()).toEqual({ repaired: 0, abandoned: 0, failed: 0 });
		expect(sessions.lane(sessionId, "child")?.state).toBe("abandoned");
		expect(manager.episodes(sessionId).find(({ id }) => id === episode.id)?.state).toBe("abandoned");

		sessions.db
			.query(
				"INSERT INTO tasks (id, session_id, state, started_at) VALUES ('conflict', ?, 'running', ?)",
			)
			.run(sessionId, "2026-08-19T00:00:00.000Z");
		sessions.createLane({ sessionId, name: "finished-child", ownerTaskId: "conflict", fromItemId: first.id });
		sessions.db
			.query("UPDATE context_lanes SET state = 'completed' WHERE session_id = ? AND name = 'finished-child'")
			.run(sessionId);
		expect(sessions.recoverLanes()).toEqual({ repaired: 0, abandoned: 0, failed: 1 });
		expect(sessions.task(sessionId, "conflict")?.status).toBe("failed");
	});

	test("finishes main atomically and remains task-authoritative on retries", () => {
		const sessions = store();
		const sessionId = sessions.create();
		const manager = new ContextManager(sessions);
		sessions.startContextTask(sessionId, "task-a", "2026-08-19T00:00:00.000Z");
		const episode = manager.startEpisode(sessionId, { name: "active work", kind: "exploration" });
		const request = {
			sessionId,
			taskId: "task-a",
			status: "failed" as const,
			startedAt: "2026-08-19T00:00:00.000Z",
			ledger: [{ type: "cancellation_requested" as const, at: "2026-08-19T00:00:01.000Z" }],
		};
		manager.finishTask(request);
		manager.finishTask({ ...request, status: "completed" });
		expect(sessions.lane(sessionId)?.state).toBe("idle");
		expect(sessions.task(sessionId, "task-a")?.status).toBe("failed");
		expect(sessions.taskLedger(sessionId, "task-a")).toHaveLength(1);
		expect(manager.episodes(sessionId).find(({ id }) => id === episode.id)?.state).toBe("failed");
		expect(sessions.episodeEvents(sessionId).filter(({ episodeId }) => episodeId === episode.id)).toHaveLength(2);
	});

	test("closes a child with one bounded handoff and never copies its trace", () => {
		const sessions = store();
		const sessionId = sessions.create();
		const manager = new ContextManager(sessions);
		const first = sessions.appendContextAtHead(input(sessionId, "first"), "main", 0);
		if ("status" in first) throw new Error("append failed");
		sessions.createLane({ sessionId, name: "child", ownerTaskId: "child-task", fromItemId: first.id });
		sessions.db
			.query("INSERT INTO tasks (id, session_id, state, started_at) VALUES ('child-task', ?, 'running', ?)")
			.run(sessionId, "2026-08-19T00:00:00.000Z");
		const trace = sessions.appendContextAtHead(input(sessionId, "private-child-trace"), "child", 0);
		if ("status" in trace) throw new Error("append failed");
		const handoff = {
			status: "completed" as const,
			findings: ["bounded result"],
			decisions: [],
			changedFiles: [],
			verification: ["checked"],
			unresolvedIssues: [],
			artifactRefs: [],
		};
		manager.finishTask({ sessionId, taskId: "child-task", status: "completed", laneId: "child", handoff });
		manager.finishTask({ sessionId, taskId: "child-task", status: "completed", laneId: "child", handoff });
		expect(sessions.lane(sessionId, "child")?.state).toBe("completed");
		const main = sessions.contextPath(sessionId, "main");
		expect(main.map(({ id }) => id)).toEqual(["first", "handoff-child-task"]);
		expect(main.at(-1)?.payload).toEqual(handoff);
		expect(main.some(({ id }) => id === "private-child-trace")).toBe(false);
	});
});
