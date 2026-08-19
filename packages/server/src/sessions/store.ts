import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { ModelConfig, ServerEvent } from "../../../shared/src/protocol";
import { structuredHash } from "../capabilities/hash";
import type {
	ContextLane,
	ContextLaneState,
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
		this.db.run("PRAGMA busy_timeout = 5000");
		migrate(this.db);
	}

	create(workspace = process.cwd()): string {
		const id = crypto.randomUUID();
		const createdAt = new Date().toISOString();
		this.db.transaction(() => {
			this.db
				.query(
					"INSERT INTO sessions (id, created_at, workspace) VALUES (?, ?, ?)",
				)
				.run(id, createdAt, workspace);
			this.db
				.query(
					"INSERT INTO context_lanes (session_id, name, state, revision, created_at) VALUES (?, 'main', 'idle', 0, ?)",
				)
				.run(id, createdAt);
		})();
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
		const lane = this.lane(input.sessionId, input.originLane ?? "main");
		if (!lane)
			throw new Error(`Unknown context lane ${input.originLane ?? "main"}`);
		const result = this.appendContextAtHead(input, lane.name, lane.revision);
		if ("status" in result)
			throw new Error("Context lane changed while appending");
		const item = result;
		if (!item) throw new Error(`Context item ${input.id} was not persisted`);
		return item;
	}

	lane(sessionId: string, name = "main"): ContextLane | undefined {
		const row = this.db
			.query(`${laneQuery} WHERE session_id = ? AND name = ?`)
			.get(sessionId, name) as ContextLaneRow | null;
		return row ? laneFromRow(row) : undefined;
	}

	lanes(sessionId: string): ContextLane[] {
		return (
			this.db
				.query(`${laneQuery} WHERE session_id = ? ORDER BY name`)
				.all(sessionId) as ContextLaneRow[]
		).map(laneFromRow);
	}

	claimMainLane(sessionId: string, taskId: string): boolean {
		return this.db.transaction(() => {
			const lane = this.lane(sessionId, "main");
			if (lane?.state === "active" && lane.ownerTaskId === taskId) return true;
			const result = this.db
				.query(
					"UPDATE context_lanes SET owner_task_id = ?, state = 'active' WHERE session_id = ? AND name = 'main' AND state = 'idle' AND owner_task_id IS NULL",
				)
				.run(taskId, sessionId);
			return result.changes > 0;
		})();
	}

	createLane(input: {
		sessionId: string;
		name: string;
		ownerTaskId: string;
		fromItemId: string;
	}): ContextLane {
		const parent = this.contextItem(input.fromItemId);
		if (!parent || parent.sessionId !== input.sessionId)
			throw new Error(
				"Lane fork item belongs to another session or is unknown",
			);
		const createdAt = new Date().toISOString();
		this.db
			.query(
				"INSERT INTO context_lanes (session_id, name, head_item_id, forked_from_item_id, owner_task_id, state, revision, created_at) VALUES (?, ?, ?, ?, ?, 'active', 0, ?)",
			)
			.run(
				input.sessionId,
				input.name,
				input.fromItemId,
				input.fromItemId,
				input.ownerTaskId,
				createdAt,
			);
		const lane = this.lane(input.sessionId, input.name);
		if (!lane) throw new Error(`Lane ${input.name} was not created`);
		return lane;
	}

	appendContextAtHead(
		input: NewContextItem,
		laneName: string,
		expectedRevision: number,
	): ContextItem | { status: "stale" } {
		const role = input.nodeRole ?? "message";
		const payloadJson = JSON.stringify(input.payload);
		if (payloadJson === undefined)
			throw new Error("Context payload must be JSON serializable");
		const compactPayloadJson =
			input.compactPayload === undefined
				? undefined
				: JSON.stringify(input.compactPayload);
		const contentHash =
			input.contentHash ??
			structuredHash({
				kind: input.kind,
				nodeRole: role,
				payload: JSON.parse(payloadJson) as unknown,
			});
		const createdAt = input.createdAt ?? new Date().toISOString();
		const parentId = input.parentId;
		try {
			const append = this.db.transaction(() => {
				const lane = this.lane(input.sessionId, laneName);
				if (!lane) throw new StaleLaneError();
				if (input.originLane !== undefined && input.originLane !== laneName)
					throw new Error("Context origin lane is immutable");
				const existing = this.contextItem(input.id);
				if (existing) {
					if (existing.contentHash !== contentHash)
						throw new Error(
							`Context item ${input.id} conflicts with existing content`,
						);
					if (existing.originLane !== laneName)
						throw new Error("Context item belongs to another lane");
					if (
						input.parentId !== undefined &&
						existing.parentId !== input.parentId
					)
						throw new Error("Context item conflicts with existing parent");
					throw new IdempotentContextItem(existing);
				}
				if (lane.revision !== expectedRevision) throw new StaleLaneError();
				if (parentId !== undefined)
					this.assertParent(input.sessionId, parentId);
				if (parentId !== undefined && parentId !== lane.headItemId)
					throw new Error("Context parent does not match lane head");
				this.db
					.query(
						"INSERT INTO context_items (id, session_id, parent_id, origin_lane, node_role, kind, payload, compact_payload, token_cost, compact_token_cost, source, group_id, episode_id, content_hash, source_digest, policy_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
					)
					.run(
						input.id,
						input.sessionId,
						lane.headItemId ?? null,
						input.originLane ?? laneName,
						role,
						input.kind,
						payloadJson,
						compactPayloadJson ?? null,
						input.tokenCost,
						input.compactTokenCost ?? null,
						input.source === undefined ? null : JSON.stringify(input.source),
						input.groupId ?? null,
						input.episodeId ?? null,
						contentHash,
						input.sourceDigest ?? null,
						input.policyVersion ?? null,
						createdAt,
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
						createdAt,
					);
				const updated = this.db
					.query(
						"UPDATE context_lanes SET head_item_id = ?, revision = revision + 1 WHERE session_id = ? AND name = ? AND revision = ?",
					)
					.run(input.id, input.sessionId, laneName, expectedRevision);
				if (updated.changes !== 1) throw new StaleLaneError();
			});
			append.immediate();
		} catch (error) {
			if (error instanceof StaleLaneError) return { status: "stale" };
			if (error instanceof IdempotentContextItem) return error.item;
			throw error;
		}
		const item = this.contextItem(input.id);
		if (!item) throw new Error(`Context item ${input.id} was not persisted`);
		return item;
	}

	contextPath(sessionId: string, laneName = "main"): ContextItem[] {
		const lane = this.lane(sessionId, laneName);
		if (!lane) throw new Error(`Unknown context lane ${laneName}`);
		const path: ContextItem[] = [];
		const seen = new Set<string>();
		let itemId = lane.headItemId;
		while (itemId) {
			if (seen.has(itemId)) throw new Error("Context tree contains a cycle");
			seen.add(itemId);
			const item = this.contextItem(itemId);
			if (!item || item.sessionId !== sessionId)
				throw new Error(`Context parent ${itemId} is invalid`);
			path.push(item);
			itemId = item.parentId;
		}
		return path.toReversed();
	}

	private assertParent(sessionId: string, parentId: string): void {
		const parent = this.contextItem(parentId);
		if (!parent || parent.sessionId !== sessionId)
			throw new Error(
				"Context parent belongs to another session or is unknown",
			);
		const seen = new Set<string>();
		let current: ContextItem | undefined = parent;
		while (current) {
			if (seen.has(current.id))
				throw new Error("Context tree contains a cycle");
			seen.add(current.id);
			current = current.parentId
				? this.contextItem(current.parentId)
				: undefined;
		}
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

const contextItemQuery = `SELECT context_items.sequence, context_items.id, context_items.session_id, context_items.parent_id, context_items.origin_lane, context_items.node_role, context_items.kind, context_items.payload, context_items.compact_payload, context_items.token_cost, context_items.compact_token_cost, context_items.source, context_items.group_id, context_items.episode_id, context_items.content_hash, context_items.source_digest, context_items.policy_version, context_items.created_at, context_lifecycle.lifecycle, context_lifecycle.projection, context_lifecycle.reason, context_lifecycle.updated_at FROM context_items JOIN context_lifecycle ON context_lifecycle.item_id = context_items.id`;

const laneQuery = `SELECT session_id, name, head_item_id, forked_from_item_id, owner_task_id, state, revision, created_at, closed_at FROM context_lanes`;

type ContextItemRow = {
	sequence: number;
	id: string;
	session_id: string;
	parent_id: string | null;
	origin_lane: string;
	node_role: ContextItem["nodeRole"];
	kind: ContextItem["kind"];
	payload: string;
	compact_payload: string | null;
	token_cost: number;
	compact_token_cost: number | null;
	source: string | null;
	group_id: string | null;
	episode_id: string | null;
	content_hash: string | null;
	source_digest: string | null;
	policy_version: number | null;
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
		...(row.parent_id === null ? {} : { parentId: row.parent_id }),
		originLane: row.origin_lane,
		nodeRole: row.node_role,
		contentHash:
			row.content_hash ??
			structuredHash({
				kind: row.kind,
				nodeRole: row.node_role,
				payload: JSON.parse(row.payload),
			}),
		...(row.source_digest === null ? {} : { sourceDigest: row.source_digest }),
		...(row.policy_version === null
			? {}
			: { policyVersion: row.policy_version }),
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

type ContextLaneRow = {
	session_id: string;
	name: string;
	head_item_id: string | null;
	forked_from_item_id: string | null;
	owner_task_id: string | null;
	state: ContextLaneState;
	revision: number;
	created_at: string;
	closed_at: string | null;
};

function laneFromRow(row: ContextLaneRow): ContextLane {
	return {
		sessionId: row.session_id,
		name: row.name,
		...(row.head_item_id === null ? {} : { headItemId: row.head_item_id }),
		...(row.forked_from_item_id === null
			? {}
			: { forkedFromItemId: row.forked_from_item_id }),
		...(row.owner_task_id === null ? {} : { ownerTaskId: row.owner_task_id }),
		state: row.state,
		revision: row.revision,
		createdAt: row.created_at,
		...(row.closed_at === null ? {} : { closedAt: row.closed_at }),
	};
}

class StaleLaneError extends Error {}

class IdempotentContextItem extends Error {
	constructor(readonly item: ContextItem) {
		super("context item already exists");
	}
}
