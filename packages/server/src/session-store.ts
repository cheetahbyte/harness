import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerEvent } from "../../shared/src/protocol";
import type { HarnessModelConfig } from "./provider";

export class SessionStore {
	readonly db: Database;

	constructor(path = ".harness/harness.sqlite") {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true });
		this.db.run(
			"CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)",
		);
		this.db.run(
			"CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)",
		);
		this.db.run(
			"CREATE TABLE IF NOT EXISTS session_settings (session_id TEXT PRIMARY KEY, model_config TEXT NOT NULL)",
		);
	}

	create(): string {
		const id = crypto.randomUUID();
		this.db
			.query("INSERT INTO sessions VALUES (?, ?)")
			.run(id, new Date().toISOString());
		return id;
	}

	exists(id: string): boolean {
		return !!this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(id);
	}

	modelConfig(sessionId: string): HarnessModelConfig | undefined {
		const row = this.db
			.query("SELECT model_config FROM session_settings WHERE session_id = ?")
			.get(sessionId) as { model_config: string } | null;
		return row
			? (JSON.parse(row.model_config) as HarnessModelConfig)
			: undefined;
	}

	setModelConfig(sessionId: string, config: HarnessModelConfig): void {
		this.db
			.query(
				"INSERT OR REPLACE INTO session_settings (session_id, model_config) VALUES (?, ?)",
			)
			.run(sessionId, JSON.stringify(config));
	}

	append(sessionId: string, event: ServerEvent): void {
		this.db
			.query(
				"INSERT INTO events (session_id, created_at, payload) VALUES (?, ?, ?)",
			)
			.run(sessionId, new Date().toISOString(), JSON.stringify(event));
	}

	events(sessionId: string): ServerEvent[] {
		return (
			this.db
				.query("SELECT payload FROM events WHERE session_id = ? ORDER BY id")
				.all(sessionId) as { payload: string }[]
		).map((row) => JSON.parse(row.payload));
	}
}
