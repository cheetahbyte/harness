import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelConfig, ServerEvent } from "../../shared/src/protocol";
import type {
	ContextEpisodeEvent,
	ContextItem,
	ContextLifecycle,
	ContextProjection,
	NewContextItem,
	NewEpisodeEvent,
} from "./context-manager";

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
		this.db.run(
			"CREATE TABLE IF NOT EXISTS context_items (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, compact_payload TEXT, token_cost INTEGER NOT NULL, compact_token_cost INTEGER, source TEXT, group_id TEXT, episode_id TEXT, created_at TEXT NOT NULL)",
		);
		this.db.run(
			"CREATE TABLE IF NOT EXISTS context_lifecycle (item_id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL, projection TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL)",
		);
		this.db.run(
			"CREATE TABLE IF NOT EXISTS context_episode_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, episode_id TEXT NOT NULL, action TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, dependencies TEXT NOT NULL, conclusion TEXT, created_at TEXT NOT NULL)",
		);
		this.db.run(
			"CREATE INDEX IF NOT EXISTS context_items_session_sequence ON context_items(session_id, sequence)",
		);
	}

	create(workspace = process.cwd()): string {
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

	appendContextItem(input: NewContextItem): ContextItem {
		this.db.transaction(() => {
			this.db
				.query(
					"INSERT INTO context_items (id, session_id, kind, payload, compact_payload, token_cost, compact_token_cost, source, group_id, episode_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					input.id,
					input.sessionId,
					input.kind,
					JSON.stringify(input.payload),
					input.compactPayload === undefined
						? null
						: JSON.stringify(input.compactPayload),
					input.tokenCost,
					input.compactTokenCost ?? null,
					input.source === undefined ? null : JSON.stringify(input.source),
					input.groupId ?? null,
					input.episodeId ?? null,
					input.createdAt,
				);
			this.db
				.query(
					"INSERT INTO context_lifecycle (item_id, lifecycle, projection, reason, updated_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(
					input.id,
					input.lifecycle,
					input.projection,
					input.reason,
					input.createdAt,
				);
		})();
		const item = this.contextItem(input.id);
		if (!item) throw new Error(`Context item ${input.id} was not persisted`);
		return item;
	}

	contextItems(sessionId: string): ContextItem[] {
		return (
			this.db
				.query(
					`${contextItemQuery} WHERE context_items.session_id = ? ORDER BY sequence`,
				)
				.all(sessionId) as ContextItemRow[]
		).map(contextItemFromRow);
	}

	contextItem(id: string): ContextItem | undefined {
		const row = this.db
			.query(`${contextItemQuery} WHERE context_items.id = ?`)
			.get(id) as ContextItemRow | null;
		return row ? contextItemFromRow(row) : undefined;
	}

	setContextLifecycle(
		id: string,
		lifecycle: ContextLifecycle,
		projection: ContextProjection,
		reason: string,
	): void {
		this.db
			.query(
				"UPDATE context_lifecycle SET lifecycle = ?, projection = ?, reason = ?, updated_at = ? WHERE item_id = ?",
			)
			.run(lifecycle, projection, reason, new Date().toISOString(), id);
	}

	appendEpisodeEvent(input: NewEpisodeEvent): ContextEpisodeEvent {
		const result = this.db
			.query(
				"INSERT INTO context_episode_events (id, session_id, episode_id, action, name, kind, dependencies, conclusion, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				input.id,
				input.sessionId,
				input.episodeId,
				input.action,
				input.name,
				input.kind,
				JSON.stringify(input.dependencies),
				input.conclusion ?? null,
				input.createdAt,
			);
		return { ...input, sequence: Number(result.lastInsertRowid) };
	}

	episodeEvents(sessionId: string): ContextEpisodeEvent[] {
		return (
			this.db
				.query(
					"SELECT sequence, id, session_id, episode_id, action, name, kind, dependencies, conclusion, created_at FROM context_episode_events WHERE session_id = ? ORDER BY sequence",
				)
				.all(sessionId) as ContextEpisodeEventRow[]
		).map((row) => ({
			sequence: row.sequence,
			id: row.id,
			sessionId: row.session_id,
			episodeId: row.episode_id,
			action: row.action,
			name: row.name,
			kind: row.kind,
			dependencies: JSON.parse(row.dependencies) as string[],
			...(row.conclusion === null ? {} : { conclusion: row.conclusion }),
			createdAt: row.created_at,
		}));
	}
}

const contextItemQuery = `SELECT context_items.sequence, context_items.id, context_items.session_id, context_items.kind, context_items.payload, context_items.compact_payload, context_items.token_cost, context_items.compact_token_cost, context_items.source, context_items.group_id, context_items.episode_id, context_items.created_at, context_lifecycle.lifecycle, context_lifecycle.projection, context_lifecycle.reason, context_lifecycle.updated_at FROM context_items JOIN context_lifecycle ON context_lifecycle.item_id = context_items.id`;

type ContextItemRow = {
	sequence: number;
	id: string;
	session_id: string;
	kind: ContextItem["kind"];
	payload: string;
	compact_payload: string | null;
	token_cost: number;
	compact_token_cost: number | null;
	source: string | null;
	group_id: string | null;
	episode_id: string | null;
	created_at: string;
	lifecycle: ContextLifecycle;
	projection: ContextProjection;
	reason: string;
	updated_at: string;
};

type ContextEpisodeEventRow = {
	sequence: number;
	id: string;
	session_id: string;
	episode_id: string;
	action: ContextEpisodeEvent["action"];
	name: string;
	kind: ContextEpisodeEvent["kind"];
	dependencies: string;
	conclusion: string | null;
	created_at: string;
};

function contextItemFromRow(row: ContextItemRow): ContextItem {
	return {
		id: row.id,
		sessionId: row.session_id,
		sequence: row.sequence,
		kind: row.kind,
		payload: JSON.parse(row.payload),
		...(row.compact_payload === null
			? {}
			: { compactPayload: JSON.parse(row.compact_payload) }),
		tokenCost: row.token_cost,
		...(row.compact_token_cost === null
			? {}
			: { compactTokenCost: row.compact_token_cost }),
		...(row.source === null ? {} : { source: JSON.parse(row.source) }),
		...(row.group_id === null ? {} : { groupId: row.group_id }),
		...(row.episode_id === null ? {} : { episodeId: row.episode_id }),
		lifecycle: row.lifecycle,
		projection: row.projection,
		reason: row.reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
