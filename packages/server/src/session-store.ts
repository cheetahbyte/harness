import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ServerEvent } from "../../shared/src/protocol";

export class SessionStore {
  readonly db: Database;

  constructor(path = ".harness/harness.sqlite") {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    this.db.run("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)");
    this.db.run("CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)");
  }

  create(): string {
    const id = crypto.randomUUID();
    this.db.query("INSERT INTO sessions VALUES (?, ?)").run(id, new Date().toISOString());
    return id;
  }

  exists(id: string): boolean { return !!this.db.query("SELECT 1 FROM sessions WHERE id = ?").get(id); }

  append(sessionId: string, event: ServerEvent): void {
    this.db.query("INSERT INTO events (session_id, created_at, payload) VALUES (?, ?, ?)").run(sessionId, new Date().toISOString(), JSON.stringify(event));
  }

  events(sessionId: string): ServerEvent[] {
    return (this.db.query("SELECT payload FROM events WHERE session_id = ? ORDER BY id").all(sessionId) as { payload: string }[]).map(row => JSON.parse(row.payload));
  }
}
