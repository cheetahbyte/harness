import { mkdirSync } from "node:fs";

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";

import { VERSION } from "../../../shared/src/version";
import { log } from "../logger";
import {
	loadMcpConfig,
	type McpConfigScan,
	type McpDiagnostic,
	type ResolvedServer,
} from "./config";

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 120_000;
/** Tool output is previewed and archived downstream; this is a sanity ceiling. */
const MAX_OUTPUT_CHARS = 256_000;

/** One tool advertised by one connected server. */
export type McpToolDescriptor = {
	server: string;
	/** The name the server knows, used on the wire. */
	tool: string;
	/** The namespaced name harnez exposes, unique across servers. */
	name: string;
	description: string;
	inputSchema: unknown;
	readOnly: boolean;
};

export type McpSnapshot = {
	tools: McpToolDescriptor[];
	diagnostics: McpDiagnostic[];
};

type Connection = {
	server: ResolvedServer;
	client: Client;
	tools: McpToolDescriptor[];
};

/**
 * Owns MCP connections for the lifetime of the server process. Connections are
 * deliberately not per-task: spawning a stdio child on every turn would add
 * seconds to each prompt.
 *
 * Every failure here is contained. A server that will not start, connect, or
 * list its tools is reported and skipped, and the rest of harnez keeps working
 * (Agent Plugins §7.2.2.5, §11.3.3).
 */
export class McpRegistry {
	private readonly connections = new Map<string, Connection>();
	private diagnostics: McpDiagnostic[] = [];
	private ready: Promise<void> | undefined;
	private closed = false;

	constructor(
		private readonly workspace: string,
		private readonly load: (workspace: string) => McpConfigScan = loadMcpConfig,
	) {}

	/** Starts connecting in the background; safe to call more than once. */
	start(): void {
		this.ready ??= this.connectAll();
	}

	/**
	 * Tool metadata has to exist before a task's capability catalog is built, so
	 * the first snapshot waits for the initial connection round. Later snapshots
	 * are served from cache.
	 */
	async snapshot(): Promise<McpSnapshot> {
		this.start();
		await this.ready;
		return {
			tools: [...this.connections.values()].flatMap(
				(connection) => connection.tools,
			),
			diagnostics: [...this.diagnostics],
		};
	}

	async call(
		server: string,
		tool: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<string> {
		const connection = this.connections.get(server);
		if (!connection) throw new Error(`MCP server not connected: ${server}`);
		const result = await connection.client.callTool(
			{
				name: tool,
				arguments: (input ?? {}) as Record<string, unknown>,
			},
			undefined,
			{ signal, timeout: CALL_TIMEOUT_MS },
		);
		const text = flatten(result["content"]);
		// A server-reported tool error is the tool failing, not the client.
		if (result["isError"]) throw new Error(text || `${tool} failed`);
		return text;
	}

	async close(): Promise<void> {
		this.closed = true;
		const connections = [...this.connections.values()];
		this.connections.clear();
		await Promise.allSettled(
			connections.map((connection) => connection.client.close()),
		);
	}

	private async connectAll(): Promise<void> {
		const scan = this.load(this.workspace);
		this.diagnostics = [...scan.diagnostics];
		for (const diagnostic of scan.diagnostics)
			log.warn(
				{
					path: diagnostic.path,
					server: diagnostic.server,
					state: diagnostic.state,
					error: diagnostic.error,
				},
				"mcp configuration ignored",
			);
		await Promise.all(scan.servers.map((server) => this.connect(server)));
	}

	private async connect(server: ResolvedServer): Promise<void> {
		if (this.closed) return;
		const client = new Client({ name: "harnez", version: VERSION });
		try {
			/**
			 * The SDK's transports declare `sessionId: string | undefined` against a
			 * `sessionId?: string` interface, which only `exactOptionalPropertyTypes`
			 * rejects. The cast is that variance, nothing more.
			 */
			await client.connect(this.transport(server) as Transport, {
				timeout: CONNECT_TIMEOUT_MS,
			});
			const connection: Connection = { server, client, tools: [] };
			// The catalog is rebuilt per task, so a refreshed list is picked up by
			// the next task without disturbing one already running.
			client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
				void this.refresh(connection);
			});
			this.connections.set(server.name, connection);
			await this.refresh(connection);
			log.info(
				{
					server: server.name,
					transport: server.transport,
					tools: connection.tools.length,
				},
				"mcp server connected",
			);
		} catch (error) {
			await client.close().catch(() => undefined);
			this.report(server.name, `failed to connect: ${message(error)}`);
		}
	}

	private transport(
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

	private async refresh(connection: Connection): Promise<void> {
		try {
			const { tools } = await connection.client.listTools();
			connection.tools = tools.map((tool) => ({
				server: connection.server.name,
				tool: tool.name,
				name: `mcp__${connection.server.name}__${tool.name}`,
				description: tool.description ?? "",
				inputSchema: tool.inputSchema,
				readOnly: tool.annotations?.readOnlyHint === true,
			}));
		} catch (error) {
			connection.tools = [];
			this.report(
				connection.server.name,
				`failed to list tools: ${message(error)}`,
			);
		}
	}

	private report(server: string, error: string): void {
		this.diagnostics.push({
			path: `mcp:${server}`,
			server,
			state: "invalid",
			error,
		});
		log.warn({ server, error }, "mcp server unavailable");
	}
}

/**
 * The spec leaves the base environment to the client (§9.1) and forbids plugins
 * from depending on it. Harnez inherits the ambient environment so that stdio
 * servers can read credentials the operator already exported, which keeps
 * secrets out of the config file.
 */
function inheritedEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env))
		if (value !== undefined) environment[key] = value;
	return environment;
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
