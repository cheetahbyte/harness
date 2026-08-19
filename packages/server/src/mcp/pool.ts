import { mkdirSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { VERSION } from "../../../shared/src/version";
import { log } from "../logger";
import { sanitizedChildEnvironment } from "../telemetry/runtime";
import type { ResolvedServer } from "./config";

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
/** Tool output is previewed and archived downstream; this is a sanity ceiling. */
const MAX_OUTPUT_CHARS = 256_000;
/** How long a connection may go unused before its child is stopped. */
const DEFAULT_IDLE_MS = 15 * 60_000;
const DEFAULT_SWEEP_MS = 60_000;

/** One tool as the server described it, before any workspace namespaces it. */
export type PooledTool = {
	name: string;
	description: string;
	inputSchema: unknown;
	readOnly: boolean;
};

export type PoolStatus = {
	/** Live or evicted-but-known: either way the server contributes tools. */
	available: boolean;
	/** Metadata is cached but the child was stopped for idleness. */
	idle: boolean;
	tools: readonly PooledTool[];
	error?: string;
};

type Entry = {
	server: ResolvedServer;
	client?: Client;
	/** In-flight connect, so concurrent holders share one handshake. */
	connecting?: Promise<void>;
	tools: PooledTool[];
	/** Registries that want this server connected, by identity. */
	holders: Set<object>;
	lastUsed: number;
	failure?: string;
	/** Stopped for idleness rather than failure; the metadata survived. */
	idle: boolean;
};

/**
 * Owns every MCP connection in the process, keyed by what a server *is* rather
 * than what a workspace calls it. Two workspaces that resolve to the same
 * command, arguments, environment, and roots share one child process, and the
 * last workspace to let go is what stops it.
 *
 * Connections outlive tasks — spawning a stdio child per turn would add seconds
 * to every prompt — but not idleness: a connection nobody has used for
 * `idleMs` is closed and revived on the next call.
 */
export class McpConnectionPool {
	private readonly entries = new Map<string, Entry>();
	private readonly idleMs: number;
	private readonly sweeper: ReturnType<typeof setInterval> | undefined;
	private closed = false;

	constructor(
		options: { idleMs?: number; sweepMs?: number; sweep?: boolean } = {},
	) {
		this.idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
		if (options.sweep === false) return;
		this.sweeper = setInterval(
			() => this.sweep(),
			options.sweepMs ?? DEFAULT_SWEEP_MS,
		);
		// The pool must never be the reason a process stays alive.
		this.sweeper.unref?.();
	}

	/**
	 * Registers interest in a server and connects it if nothing else has. The
	 * status is returned rather than thrown: one server that will not start is
	 * reported and skipped, never fatal to the workspace holding it.
	 */
	async acquire(holder: object, server: ResolvedServer): Promise<PoolStatus> {
		const key = connectionKey(server);
		let entry = this.entries.get(key);
		if (!entry) {
			entry = {
				server,
				tools: [],
				holders: new Set(),
				lastUsed: Date.now(),
				idle: false,
			};
			this.entries.set(key, entry);
		}
		entry.holders.add(holder);
		await this.connect(key, entry);
		return status(entry);
	}

	/** Drops one workspace's interest, stopping the child once nobody holds it. */
	async release(holder: object, server: ResolvedServer): Promise<void> {
		const key = connectionKey(server);
		const entry = this.entries.get(key);
		if (!entry?.holders.delete(holder)) return;
		if (entry.holders.size) return;
		this.entries.delete(key);
		await close(entry);
		log.info({ server: entry.server.name }, "mcp server released");
	}

	status(server: ResolvedServer): PoolStatus | undefined {
		const entry = this.entries.get(connectionKey(server));
		return entry && status(entry);
	}

	/**
	 * Calls a tool, reconnecting first when the connection was evicted while
	 * idle. The revival is invisible to the caller beyond the added latency.
	 */
	async call(
		server: ResolvedServer,
		tool: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<string> {
		const key = connectionKey(server);
		const entry = this.entries.get(key);
		if (!entry) throw new Error(`MCP server not connected: ${server.name}`);
		entry.lastUsed = Date.now();
		if (!entry.client && entry.failure)
			throw new Error(
				`MCP server not connected: ${server.name} (${entry.failure})`,
			);
		if (!entry.client) await this.connect(key, entry);
		const client = entry.client;
		if (!client)
			throw new Error(
				`MCP server not connected: ${server.name}${
					entry.failure ? ` (${entry.failure})` : ""
				}`,
			);
		let result: Awaited<ReturnType<Client["callTool"]>>;
		try {
			result = await client.callTool(
				{ name: tool, arguments: (input ?? {}) as Record<string, unknown> },
				undefined,
				{ signal, timeout: CALL_TIMEOUT_MS },
			);
		} catch (error) {
			// The child may have exited while the client object still exists.
			delete entry.client;
			entry.idle = true;
			void client.close().catch(() => undefined);
			throw error;
		}
		entry.lastUsed = Date.now();
		const text = flatten(result["content"]);
		// A server-reported tool error is the tool failing, not the client.
		if (result["isError"]) throw new Error(text || `${tool} failed`);
		return text;
	}

	/**
	 * Stops connections nobody has used lately. Tool metadata is kept, so a
	 * catalog built after an eviction still describes the server accurately and
	 * only a call pays to bring it back.
	 */
	sweep(now = Date.now()): void {
		for (const entry of this.entries.values()) {
			if (!entry.client || now - entry.lastUsed < this.idleMs) continue;
			const client = entry.client;
			delete entry.client;
			entry.idle = true;
			void client.close().catch(() => undefined);
			log.info(
				{ server: entry.server.name, tools: entry.tools.length },
				"mcp server evicted while idle",
			);
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		if (this.sweeper) clearInterval(this.sweeper);
		const entries = [...this.entries.values()];
		this.entries.clear();
		await Promise.allSettled(entries.map((entry) => close(entry)));
	}

	private async connect(key: string, entry: Entry): Promise<void> {
		if (this.closed || entry.client) return;
		entry.connecting ??= this.handshake(key, entry).finally(() => {
			delete entry.connecting;
		});
		await entry.connecting;
	}

	private async handshake(key: string, entry: Entry): Promise<void> {
		const { server } = entry;
		// A retry starts from a clean slate; a stale failure would outlive its cause.
		delete entry.failure;
		const client = new Client({ name: "harnez", version: VERSION });
		try {
			/**
			 * The SDK's transports declare `sessionId: string | undefined` against a
			 * `sessionId?: string` interface, which only `exactOptionalPropertyTypes`
			 * rejects. The cast is that variance, nothing more.
			 */
			await client.connect(transportFor(server) as Transport, {
				timeout: CONNECT_TIMEOUT_MS,
			});
			// The catalog is rebuilt per task, so a refreshed list is picked up by
			// the next task without disturbing one already running.
			client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
				void this.refresh(key, client);
			});
			// Losing the race against `close()` would strand this child process.
			if (this.closed || !this.entries.has(key)) {
				await client.close().catch(() => undefined);
				return;
			}
			entry.client = client;
			entry.idle = false;
			entry.lastUsed = Date.now();
			await this.refresh(key, client);
			log.info(
				{
					server: server.name,
					transport: server.transport,
					tools: entry.tools.length,
				},
				"mcp server connected",
			);
		} catch (error) {
			await client.close().catch(() => undefined);
			entry.failure = `failed to connect: ${message(error)}`;
			entry.tools = [];
			log.warn(
				{ server: server.name, error: entry.failure },
				"mcp server unavailable",
			);
		}
	}

	private async refresh(key: string, client: Client): Promise<void> {
		const entry = this.entries.get(key);
		// A notification can outlive the connection that sent it.
		if (!entry || (entry.client && entry.client !== client)) return;
		try {
			const { tools } = await client.listTools();
			entry.tools = tools.map((tool) => ({
				name: tool.name,
				description: tool.description ?? "",
				inputSchema: tool.inputSchema,
				readOnly: tool.annotations?.readOnlyHint === true,
			}));
		} catch (error) {
			entry.tools = [];
			entry.failure = `failed to list tools: ${message(error)}`;
			log.warn(
				{ server: entry.server.name, error: entry.failure },
				"mcp server unavailable",
			);
		}
	}
}

/**
 * The identity of a connection: everything that decides which process, with
 * which state, answers a call. The configured name is deliberately absent, so
 * one server named differently in two workspaces is still one child — while
 * `PLUGIN_DATA`, which is derived from the name, keeps genuinely separate
 * installations apart.
 */
function connectionKey(server: ResolvedServer): string {
	if (server.transport === "streamable-http")
		return JSON.stringify([
			"streamable-http",
			server.url,
			sorted(server.headers),
		]);
	return JSON.stringify([
		"stdio",
		server.command,
		server.args,
		sorted(server.env),
		server.cwd,
		server.pluginRoot,
		server.pluginData,
	]);
}

function status(entry: Entry): PoolStatus {
	return {
		available: !entry.failure && (!!entry.client || entry.idle),
		idle: entry.idle && !entry.client,
		tools: entry.tools,
		...(entry.failure ? { error: entry.failure } : {}),
	};
}

async function close(entry: Entry): Promise<void> {
	const client = entry.client;
	delete entry.client;
	if (client) await client.close().catch(() => undefined);
}

function sorted(values: Record<string, string>): [string, string][] {
	return Object.entries(values).toSorted(([a], [b]) => a.localeCompare(b));
}

function transportFor(
	server: ResolvedServer,
): StdioClientTransport | StreamableHTTPClientTransport {
	if (server.transport === "streamable-http")
		return new StreamableHTTPClientTransport(
			new URL(server.url),
			Object.keys(server.headers).length
				? { requestInit: { headers: server.headers } }
				: {},
		);
	// PLUGIN_DATA must exist and be writable before the child starts (§9.1).
	mkdirSync(server.pluginData, { recursive: true });
	return new StdioClientTransport({
		command: server.command,
		args: server.args,
		cwd: server.cwd,
		/**
		 * Configured entries overlay the base environment, then the client sets
		 * the reserved variables last so a config cannot shadow them (§9.1).
		 */
		env: {
			...inheritedEnvironment(),
			...server.env,
			PLUGIN_ROOT: server.pluginRoot,
			PLUGIN_DATA: server.pluginData,
		},
		// Never "inherit": a chatty server would otherwise corrupt the TUI.
		stderr: "pipe",
	});
}

/**
 * The spec leaves the base environment to the client (§9.1) and forbids plugins
 * from depending on it. Harnez inherits the ambient environment so that stdio
 * servers can read credentials the operator already exported, which keeps
 * secrets out of the config file.
 */
function inheritedEnvironment(): Record<string, string> {
	return sanitizedChildEnvironment();
}

function flatten(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const item = part as { type?: string; text?: string };
			if (item.type === "text") return item.text ?? "";
			// Non-text content is summarized rather than dropped silently.
			return `[${item.type ?? "unknown"} content]`;
		})
		.join("")
		.slice(0, MAX_OUTPUT_CHARS);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
