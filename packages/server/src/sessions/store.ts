import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ModelConfig, ServerEvent } from "../../../shared/src/protocol";
import type {
	ContextEpisodeEvent,
	ContextItem,
	ContextLifecycle,
	ContextProjection,
	NewContextItem,
	NewEpisodeEvent,
} from "../context/types";
import type { ExecutionLedgerEntry } from "../task-ledger";
import type { TaskTerminalStatus } from "../task-runtime";
import { migrate } from "./migrations";

export interface SessionSummary {
	id: string;
	createdAt: string;
	workspace: string | null;
	title: string | null;
}

const DATABASE_PATH = ".harnez/harnez.sqlite";
const LEGACY_DATABASE_PATH = ".harness/harness.sqlite";

/**
 * A database written before the rename keeps being used in place, so upgrading
 * never starts a workspace over with an empty session history.
 */
function defaultDatabasePath(): string {
	return !existsSync(DATABASE_PATH) && existsSync(LEGACY_DATABASE_PATH)
		? LEGACY_DATABASE_PATH
		: DATABASE_PATH;
}

export class SessionStore {
	readonly db: Database;

	constructor(path = defaultDatabasePath()) {
		mkdirSync(dirname(path), { recursive: true });
		this.db = new Database(path, { create: true });
		migrate(this.db);
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

	list(): SessionSummary[] {
		return this.db
			.query(
				"SELECT id, created_at AS createdAt, workspace, title FROM sessions WHERE has_user_message = 1 ORDER BY created_at DESC",
			)
			.all() as SessionSummary[];
	}

	markUserMessage(sessionId: string): void {
		this.db
			.query("UPDATE sessions SET has_user_message = 1 WHERE id = ?")
			.run(sessionId);
	}

	claimNamingPrompt(sessionId: string): boolean {
		return (
			this.db
				.query(
					"UPDATE sessions SET naming_prompt_consumed = 1 WHERE id = ? AND naming_prompt_consumed = 0",
				)
				.run(sessionId).changes > 0
		);
	}

	setTitle(sessionId: string, title: string): void {
		this.db
			.query("UPDATE sessions SET title = ? WHERE id = ?")
			.run(title, sessionId);
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

	appendTaskLedger(
		sessionId: string,
		taskId: string,
		entries: readonly ExecutionLedgerEntry[],
	): void {
		this.db.transaction(() => {
			for (const entry of entries)
				this.db
					.query(
						"INSERT INTO task_ledger (session_id, task_id, payload) VALUES (?, ?, ?)",
					)
					.run(sessionId, taskId, JSON.stringify(entry));
		})();
	}

	taskLedger(sessionId: string, taskId: string): ExecutionLedgerEntry[] {
		return (
			this.db
				.query(
					"SELECT payload FROM task_ledger WHERE session_id = ? AND task_id = ? ORDER BY sequence",
				)
				.all(sessionId, taskId) as { payload: string }[]
		).map(({ payload }) => JSON.parse(payload) as ExecutionLedgerEntry);
	}

	recordTaskTerminal(
		sessionId: string,
		taskId: string,
		status: TaskTerminalStatus,
		startedAt: string,
	): void {
		this.db
			.query(
				"INSERT OR REPLACE INTO tasks (id, session_id, state, status, started_at, finished_at) VALUES (?, ?, 'terminal', ?, ?, ?)",
			)
			.run(taskId, sessionId, status, startedAt, new Date().toISOString());
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

	contextSequence(sessionId: string): number {
		return this.contextItems(sessionId).at(-1)?.sequence ?? 0;
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
