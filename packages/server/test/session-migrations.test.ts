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
	const path = mkdtempSync(join(tmpdir(), "harness-migrations-"));
	paths.push(path);
	return join(path, "state.sqlite");
}

function userVersion(store: SessionStore): number {
	return (store.db.query("PRAGMA user_version").get() as {
		user_version: number;
	}).user_version;
}

function tableNames(store: SessionStore): string[] {
	return (
		store.db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
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
	"context_lifecycle",
	"events",
	"session_settings",
	"sessions",
	"sqlite_sequence",
	"task_ledger",
	"tasks",
];

describe("session schema migrations", () => {
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
});
