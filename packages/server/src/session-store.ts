import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelConfig, ServerEvent } from "../../shared/src/protocol";

export class SessionStore {
	readonly db: Database;

	constructor(path = ".harness/harness.sqlite") {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true });
		this.db.run(
			"CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, workspace TEXT)",
		);
		const columns = this.db.query("PRAGMA table_info(sessions)").all() as {
			name: string;
		}[];
		if (!columns.some((column) => column.name === "workspace"))
			this.db.run("ALTER TABLE sessions ADD COLUMN workspace TEXT");
		this.db.run(
			"CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)",
		);
		this.db.run(
			"CREATE TABLE IF NOT EXISTS session_settings (session_id TEXT PRIMARY KEY, model_config TEXT NOT NULL)",
		);
	}

	create(workspace: string): string {
		const id = crypto.randomUUID();
		this.db
			.query(
				"INSERT INTO sessions (id, created_at, workspace) VALUES (?, ?, ?)",
			)
			.run(id, new Date().toISOString(), workspace);
		return id;
	}

	exists(id: string): boolean {
		return !!this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(id);
	}

	workspace(sessionId: string): string | undefined {
		const row = this.db
			.query("SELECT workspace FROM sessions WHERE id = ?")
			.get(sessionId) as { workspace: string | null } | null;
		return row?.workspace ?? undefined;
	}

	modelConfig(sessionId: string): ModelConfig | undefined {
		const row = this.db
			.query("SELECT model_config FROM session_settings WHERE session_id = ?")
			.get(sessionId) as { model_config: string } | null;
		return row ? (JSON.parse(row.model_config) as ModelConfig) : undefined;
	}

	setModelConfig(sessionId: string, config: ModelConfig): void {
		this.db
			.query(
				"INSERT OR REPLACE INTO session_settings (session_id, model_config) VALUES (?, ?)",
			)
			.run(sessionId, JSON.stringify(config));
	}

	/** Returns the row id, which doubles as the event's resume cursor. */
	append(sessionId: string, event: ServerEvent): number {
		const { lastInsertRowid } = this.db
			.query(
				"INSERT INTO events (session_id, created_at, payload) VALUES (?, ?, ?)",
			)
			.run(sessionId, new Date().toISOString(), JSON.stringify(event));
		return Number(lastInsertRowid);
	}

	events(sessionId: string): ServerEvent[] {
		return this.eventsFrom(sessionId).map((row) => row.event);
	}

	/** Persisted events after the `from` cursor, oldest first. */
	eventsFrom(
		sessionId: string,
		from = 0,
	): { seq: number; event: ServerEvent }[] {
		return (
			this.db
				.query(
					"SELECT id, payload FROM events WHERE session_id = ? AND id > ? ORDER BY id",
				)
				.all(sessionId, from) as { id: number; payload: string }[]
		).map((row) => ({
			seq: row.id,
			event: JSON.parse(row.payload) as ServerEvent,
		}));
	}
}
