import type { Database } from "bun:sqlite";

type Migration = {
	version: number;
	run(db: Database): void;
};

const migrations: readonly Migration[] = [
	{
		version: 1,
		run(db) {
			db.run(
				"CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
			);
			db.run(
				"CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)",
			);
		},
	},
	{
		version: 2,
		run(db) {
			db.run(
				"CREATE TABLE IF NOT EXISTS session_settings (session_id TEXT PRIMARY KEY, model_config TEXT NOT NULL)",
			);
		},
	},
	{
		version: 3,
		run(db) {
			if (!hasColumn(db, "sessions", "workspace"))
				db.run("ALTER TABLE sessions ADD COLUMN workspace TEXT");
			db.run(
				"CREATE TABLE IF NOT EXISTS context_items (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, compact_payload TEXT, token_cost INTEGER NOT NULL, compact_token_cost INTEGER, source TEXT, group_id TEXT, episode_id TEXT, created_at TEXT NOT NULL)",
			);
			db.run(
				"CREATE TABLE IF NOT EXISTS context_lifecycle (item_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL, projection TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL)",
			);
			db.run(
				"CREATE TABLE IF NOT EXISTS context_episode_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, episode_id TEXT NOT NULL, action TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, dependencies TEXT NOT NULL, conclusion TEXT, created_at TEXT NOT NULL)",
			);
			db.run(
				"CREATE INDEX IF NOT EXISTS context_items_session_sequence ON context_items(session_id, sequence)",
			);
		},
	},
	{
		version: 4,
		run(db) {
			db.run(
				"CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, state TEXT NOT NULL, status TEXT, started_at TEXT NOT NULL, finished_at TEXT)",
			);
			db.run(
				"CREATE TABLE IF NOT EXISTS task_ledger (sequence INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, task_id TEXT NOT NULL, payload TEXT NOT NULL)",
			);
		},
	},
	{
		version: 5,
		run(db) {
			if (!hasColumn(db, "sessions", "title"))
				db.run("ALTER TABLE sessions ADD COLUMN title TEXT");
			if (!hasColumn(db, "sessions", "naming_prompt_consumed"))
				db.run(
					"ALTER TABLE sessions ADD COLUMN naming_prompt_consumed INTEGER NOT NULL DEFAULT 0",
				);
		},
	},
	{
		version: 6,
		run(db) {
			if (!hasColumn(db, "sessions", "has_user_message"))
				db.run(
					"ALTER TABLE sessions ADD COLUMN has_user_message INTEGER NOT NULL DEFAULT 0",
				);
			db.run(
				"UPDATE sessions SET has_user_message = 1 WHERE EXISTS (SELECT 1 FROM context_items WHERE context_items.session_id = sessions.id AND context_items.kind = 'user') OR EXISTS (SELECT 1 FROM tasks WHERE tasks.session_id = sessions.id)",
			);
		},
	},
];

export const LATEST_SCHEMA_VERSION = migrations.length;

export function migrate(db: Database): void {
	let version = userVersion(db);
	if (version === 0 && hasTable(db, "sessions")) {
		version = legacyVersion(db);
		db.run(`PRAGMA user_version = ${version}`);
	}
	if (version > LATEST_SCHEMA_VERSION)
		throw new Error(
			`database schema ${version} is newer than supported ${LATEST_SCHEMA_VERSION}`,
		);
	for (const migration of migrations.slice(version))
		db.transaction(() => {
			migration.run(db);
			db.run(`PRAGMA user_version = ${migration.version}`);
		})();
}

function userVersion(db: Database): number {
	return (db.query("PRAGMA user_version").get() as { user_version: number })
		.user_version;
}

function legacyVersion(db: Database): number {
	if (!hasTable(db, "events")) return 0;
	if (!hasTable(db, "session_settings")) return 1;
	if (!hasWorkspaceAndContext(db)) return 2;
	if (!hasTable(db, "tasks") || !hasTable(db, "task_ledger")) return 3;
	if (
		!hasColumn(db, "sessions", "title") ||
		!hasColumn(db, "sessions", "naming_prompt_consumed")
	)
		return 4;
	if (!hasColumn(db, "sessions", "has_user_message")) return 5;
	return 6;
}

function hasWorkspaceAndContext(db: Database): boolean {
	return (
		hasColumn(db, "sessions", "workspace") &&
		hasTable(db, "context_items") &&
		hasTable(db, "context_lifecycle") &&
		hasTable(db, "context_episode_events") &&
		hasIndex(db, "context_items_session_sequence")
	);
}

function hasTable(db: Database, name: string): boolean {
	return !!db
		.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
		.get(name);
}

function hasIndex(db: Database, name: string): boolean {
	return !!db
		.query("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
		.get(name);
}

function hasColumn(db: Database, table: string, column: string): boolean {
	return (
		db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]
	).some((entry) => entry.name === column);
}
