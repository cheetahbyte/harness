import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_SCHEMA_VERSION } from "../src/sessions/migrations";
import { SessionStore } from "../src/sessions/store";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function databasePath(): string {
	const path = mkdtempSync(join(tmpdir(), "harnez-migrations-"));
	paths.push(path);
	return join(path, "state.sqlite");
}

function userVersion(store: SessionStore): number {
	return (
		store.db.query("PRAGMA user_version").get() as {
			user_version: number;
		}
	).user_version;
}

function tableNames(store: SessionStore): string[] {
	return (
		store.db
			.query(
				"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
			)
			.all() as { name: string }[]
	).map(({ name }) => name);
}

function columnNames(store: SessionStore, table: string): string[] {
	return (
		store.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
	).map(({ name }) => name);
}

const schemaTables = [
	"context_episode_events",
	"context_items",
	"context_lanes",
	"context_lifecycle",
	"events",
	"session_settings",
	"sessions",
	"sqlite_sequence",
	"subagents",
	"task_ledger",
	"tasks",
];

describe("session schema migrations", () => {
	test("waits for a concurrent writer instead of dropping context", async () => {
		const path = databasePath();
		const store = new SessionStore(path);
		const sessionId = store.create();
		const holder = Bun.spawn(
			[
				"bun",
				"-e",
				`import { Database } from "bun:sqlite";
const db = new Database(process.argv[1]);
db.run("BEGIN IMMEDIATE");
console.log("locked");
await Bun.sleep(250);
db.run("COMMIT");`,
				path,
			],
			{ stdout: "pipe" },
		);
		const lock = await holder.stdout.getReader().read();
		expect(new TextDecoder().decode(lock.value)).toContain("locked");

		expect(() =>
			store.appendContextItem({
				id: "context-1",
				sessionId,
				kind: "assistant",
				payload: { role: "assistant", content: "keep me" },
				tokenCost: 2,
				lifecycle: "active",
				projection: "full",
				reason: "agent message",
				createdAt: "2026-08-13T00:00:00.000Z",
			}),
		).not.toThrow();
		expect(await holder.exited).toBe(0);
		store.db.close();
	});

	test("creates the latest schema for a fresh database", () => {
		const store = new SessionStore(databasePath());

		expect(userVersion(store)).toBe(LATEST_SCHEMA_VERSION);
		expect(tableNames(store)).toEqual(schemaTables);
		expect(columnNames(store, "sessions")).toEqual([
			"id",
			"created_at",
			"workspace",
			"title",
			"naming_prompt_consumed",
			"has_user_message",
		]);
		expect(columnNames(store, "subagents")).toEqual([
			"id",
			"session_id",
			"parent_agent_id",
			"profile",
			"description",
			"lane_id",
			"depth",
			"state",
			"run_number",
			"active_task_id",
			"pending_message",
			"result",
			"worktree_path",
			"worktree_branch",
			"base_commit",
			"created_at",
			"started_at",
			"finished_at",
		]);
		store.db.close();
	});

	test("persists and updates a resumable subagent record", () => {
		const store = new SessionStore(databasePath());
		const sessionId = store.create();
		const created = store.createSubagent({
			id: "agent-1",
			sessionId,
			profile: "explore",
			description: "Inspect the repository",
			depth: 1,
			createdAt: "2026-08-20T00:00:00.000Z",
		});
		expect(created).toMatchObject({
			id: "agent-1",
			state: "queued",
			runNumber: 0,
			createdAt: "2026-08-20T00:00:00.000Z",
		});
		const running = store.startSubagentRun(
			sessionId,
			"agent-1",
			"task-1",
			"2026-08-20T00:01:00.000Z",
		);
		expect(running).toMatchObject({
			state: "running",
			runNumber: 1,
			activeTaskId: "task-1",
		});
		const result = {
			status: "completed" as const,
			summary: "## Findings\n\nDone.\n\n## Verification\n\nTests.",
		};
		store.updateSubagent(sessionId, "agent-1", {
			state: "completed",
			result,
			finishedAt: "2026-08-20T00:02:00.000Z",
		});
		expect(store.subagents(sessionId)).toEqual([
			{
				...created,
				state: "completed",
				runNumber: 1,
				activeTaskId: "task-1",
				startedAt: "2026-08-20T00:01:00.000Z",
				finishedAt: "2026-08-20T00:02:00.000Z",
				result,
			},
		]);
		store.db
			.query("UPDATE subagents SET result = ? WHERE id = ?")
			.run(
				JSON.stringify({
					status: "completed",
					findings: ["legacy finding"],
					verification: ["legacy check"],
				}),
				"agent-1",
			);
		expect(store.subagent(sessionId, "agent-1")?.result?.summary).toBe(
			"## Findings\n\n- legacy finding\n\n## Verification\n\n- legacy check",
		);
		expect(
			store.startSubagentRun(sessionId, "agent-1", "task-2"),
		).toBeDefined();
		store.db.close();
	});

	test("upgrades the oldest released schema without rewriting sessions", () => {
		const path = databasePath();
		const legacy = new Database(path);
		legacy.run(
			"CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
		);
		legacy.run(
			"CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)",
		);
		legacy
			.query("INSERT INTO sessions (id, created_at) VALUES (?, ?)")
			.run("legacy-session", "2026-01-01T00:00:00.000Z");
		legacy.close();

		const upgraded = new SessionStore(path);
		expect(upgraded.exists("legacy-session")).toBe(true);
		expect(upgraded.workspace("legacy-session")).toBeUndefined();
		expect(upgraded.list()).toEqual([]);
		upgraded.markUserMessage("legacy-session");
		expect(upgraded.list()).toEqual([
			{
				id: "legacy-session",
				createdAt: "2026-01-01T00:00:00.000Z",
				workspace: null,
				title: null,
			},
		]);
		expect(upgraded.claimNamingPrompt("legacy-session")).toBe(true);
		expect(upgraded.claimNamingPrompt("legacy-session")).toBe(false);
		upgraded.setTitle("legacy-session", "Legacy title");
		expect(upgraded.list()[0]?.title).toBe("Legacy title");
		expect(userVersion(upgraded)).toBe(LATEST_SCHEMA_VERSION);
		expect(tableNames(upgraded)).toEqual(schemaTables);
		upgraded.db.close();
		const unversioned = new Database(path);
		unversioned.run("PRAGMA user_version = 0");
		unversioned.close();

		const reopened = new SessionStore(path);
		expect(reopened.exists("legacy-session")).toBe(true);
		expect(reopened.claimNamingPrompt("legacy-session")).toBe(false);
		expect(userVersion(reopened)).toBe(LATEST_SCHEMA_VERSION);
		reopened.db.close();
	});

	test("rejects databases newer than this binary supports", () => {
		const path = databasePath();
		const database = new Database(path);
		database.run(`PRAGMA user_version = ${LATEST_SCHEMA_VERSION + 1}`);
		database.close();

		expect(() => new SessionStore(path)).toThrow("newer than supported");
	});

	test("keeps previously messaged sessions visible after the activity migration", () => {
		const path = databasePath();
		const old = new SessionStore(path);
		const id = old.create("/workspace");
		old.recordTaskTerminal(
			id,
			"task-1",
			"completed",
			"2026-01-01T00:00:00.000Z",
		);
		old.db.run("ALTER TABLE sessions DROP COLUMN has_user_message");
		old.db.run("PRAGMA user_version = 5");
		old.db.close();

		const upgraded = new SessionStore(path);
		expect(upgraded.list().map((session) => session.id)).toEqual([id]);
		upgraded.db.close();
	});

	test("backfills the persistent tree and repairs missing lifecycle rows", () => {
		const path = databasePath();
		const legacy = new Database(path);
		legacy.run(
			"CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, workspace TEXT, title TEXT, naming_prompt_consumed INTEGER NOT NULL DEFAULT 0, has_user_message INTEGER NOT NULL DEFAULT 0)",
		);
		legacy.run(
			"CREATE TABLE events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)",
		);
		legacy.run(
			"CREATE TABLE session_settings (session_id TEXT PRIMARY KEY, model_config TEXT NOT NULL)",
		);
		legacy.run(
			"CREATE TABLE context_items (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, compact_payload TEXT, token_cost INTEGER NOT NULL, compact_token_cost INTEGER, source TEXT, group_id TEXT, episode_id TEXT, created_at TEXT NOT NULL)",
		);
		legacy.run(
			"CREATE TABLE context_lifecycle (item_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL, projection TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		legacy.run(
			"CREATE TABLE context_episode_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, episode_id TEXT NOT NULL, action TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, dependencies TEXT NOT NULL, conclusion TEXT, created_at TEXT NOT NULL)",
		);
		legacy.run(
			"CREATE TABLE tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, status TEXT, started_at TEXT NOT NULL, finished_at TEXT)",
		);
		legacy.run(
			"CREATE TABLE task_ledger (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, task_id TEXT NOT NULL, payload TEXT NOT NULL)",
		);
		legacy.run(
			"CREATE INDEX context_items_session_sequence ON context_items(session_id, sequence)",
		);
		legacy
			.query(
				"INSERT INTO sessions (id, created_at, workspace) VALUES (?, ?, ?)",
			)
			.run("migrated", "2026-08-19T00:00:00.000Z", "/workspace");
		const contextRows: Array<[string, string, string]> = [
			["active", "assistant", "one"],
			["archived", "tool-result", "two"],
			["observation", "observation", "three"],
		];
		for (const [id, kind, payload] of contextRows)
			legacy
				.query(
					"INSERT INTO context_items (id, session_id, kind, payload, token_cost, created_at) VALUES (?, 'migrated', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
				)
				.run(id, kind, JSON.stringify({ content: payload }));
		legacy
			.query(
				"INSERT INTO context_lifecycle (item_id, lifecycle, projection, reason, updated_at) VALUES (?, 'active', 'full', 'legacy', '2026-08-19T00:00:00.000Z')",
			)
			.run("active");
		legacy.run("PRAGMA user_version = 6");
		legacy.close();

		const upgraded = new SessionStore(path);
		expect(columnNames(upgraded, "context_items")).toEqual(
			expect.arrayContaining([
				"parent_id",
				"origin_lane",
				"node_role",
				"content_hash",
				"source_digest",
				"policy_version",
			]),
		);
		expect(upgraded.lane("migrated")).toMatchObject({
			name: "main",
			state: "idle",
			revision: 3,
		});
		expect(upgraded.contextPath("migrated").map(({ id }) => id)).toEqual([
			"active",
			"archived",
			"observation",
		]);
		expect(upgraded.contextItem("archived")?.reason).toBe("migration-repair");
		upgraded.db.close();
	});
});
