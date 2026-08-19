import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NewContextItem } from "../src/context/types";
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
		expect(sessions.claimMainLane(sessionId, "task-b")).toBe(false);

		const first = sessions.appendContextAtHead(input(sessionId, "first"), "main", 0);
		expect("status" in first).toBe(false);
		if ("status" in first) return;
		expect(first.parentId).toBeUndefined();
		expect(sessions.appendContextAtHead(input(sessionId, "second"), "main", 0)).toEqual({ status: "stale" });
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
});
