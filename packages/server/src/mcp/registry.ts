import { log } from "../logger";
import {
	loadMcpConfig,
	type McpConfigScan,
	type McpDiagnostic,
	type McpScope,
	type ResolvedServer,
} from "./config";
import { McpConnectionPool, type PooledTool } from "./pool";

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

/** What the MCP menu needs to draw one row and toggle it. */
export type McpServerStatus = {
	name: string;
	scope: McpScope;
	transport: ResolvedServer["transport"];
	enabled: boolean;
	connected: boolean;
	/** Connected, but its child was stopped while idle; the next call revives it. */
	idle: boolean;
	tools: number;
	error?: string;
};

export type McpRegistryOptions = {
	load?: (workspace: string) => McpConfigScan;
	/** Consulted on every connection round, so toggling takes effect live. */
	enabled?: (server: string) => boolean;
	/** Shared so identical servers in sibling workspaces are one child process. */
	pool?: McpConnectionPool;
};

/**
 * One workspace's view of MCP: which servers its `mcp.json` files resolve to,
 * which of them the operator left switched on, and what they expose. The
 * connections themselves belong to the pool, because two workspaces
 * configuring the same server should not run it twice.
 *
 * Every failure here is contained. A server that will not start, connect, or
 * list its tools is reported and skipped, and the rest of harnez keeps working
 * (Agent Plugins §7.2.2.5, §11.3.3).
 */
export class McpRegistry {
	private readonly load: (workspace: string) => McpConfigScan;
	private readonly pool: McpConnectionPool;
	private readonly ownsPool: boolean;
	private enabled: (server: string) => boolean;
	private servers: ResolvedServer[] = [];
	private configDiagnostics: McpDiagnostic[] = [];
	private ready: Promise<void> | undefined;
	private closed = false;

	constructor(
		private readonly workspace: string,
		options: McpRegistryOptions = {},
	) {
		this.load = options.load ?? loadMcpConfig;
		this.enabled = options.enabled ?? (() => true);
		this.ownsPool = !options.pool;
		this.pool = options.pool ?? new McpConnectionPool();
	}

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
		const tools: McpToolDescriptor[] = [];
		const diagnostics = [...this.configDiagnostics];
		for (const server of this.servers) {
			if (!this.enabled(server.name)) continue;
			const status = this.pool.status(server);
			if (status?.error)
				diagnostics.push({
					path: `mcp:${server.name}`,
					server: server.name,
					state: "invalid",
					error: status.error,
				});
			for (const tool of status?.tools ?? [])
				tools.push(describe(server.name, tool));
		}
		return { tools, diagnostics };
	}

	/**
	 * One row per configured server, including the ones switched off and the ones
	 * that failed: a menu that hid either would leave the operator no way back.
	 */
	async list(): Promise<McpServerStatus[]> {
		this.start();
		await this.ready;
		return this.servers.map((server) => {
			const enabled = this.enabled(server.name);
			const status = enabled ? this.pool.status(server) : undefined;
			const tools = status?.tools ?? [];
			return {
				name: server.name,
				scope: server.scope,
				transport: server.transport,
				enabled,
				connected: !!status?.available,
				idle: !!status?.idle,
				tools: tools.length,
				...(status?.error ? { error: status.error } : {}),
			};
		});
	}

	async call(
		server: string,
		tool: string,
		input: unknown,
		signal: AbortSignal,
	): Promise<string> {
		const resolved = this.servers.find(
			(candidate) => candidate.name === server && this.enabled(candidate.name),
		);
		if (!resolved) throw new Error(`MCP server not connected: ${server}`);
		return this.pool.call(resolved, tool, input, signal);
	}

	/**
	 * Applies a new enabled predicate: servers switched off are released (the
	 * child stops once no other workspace holds it), and servers switched on
	 * connect now rather than at the next prompt, so the menu can report the
	 * outcome straight away.
	 */
	async setEnabled(enabled: (server: string) => boolean): Promise<void> {
		this.start();
		await this.ready;
		this.enabled = enabled;
		if (this.closed) return;
		await Promise.allSettled(
			this.servers.map((server) =>
				enabled(server.name)
					? this.pool.acquire(this, server)
					: this.pool.release(this, server),
			),
		);
	}

	/** Releases this workspace's connections; other workspaces keep theirs. */
	async close(): Promise<void> {
		this.closed = true;
		const servers = this.servers;
		this.servers = [];
		if (this.ownsPool) return this.pool.close();
		await Promise.allSettled(
			servers.map((server) => this.pool.release(this, server)),
		);
	}

	private async connectAll(): Promise<void> {
		const scan = this.load(this.workspace);
		this.servers = [...scan.servers];
		this.configDiagnostics = [...scan.diagnostics];
		for (const diagnostic of scan.diagnostics)
			log.warn(
				{
					workspace: this.workspace,
					path: diagnostic.path,
					server: diagnostic.server,
					state: diagnostic.state,
					error: diagnostic.error,
				},
				"mcp configuration ignored",
			);
		if (this.closed) return;
		await Promise.all(
			scan.servers
				.filter((server) => this.enabled(server.name))
				.map((server) => this.pool.acquire(this, server)),
		);
	}
}

function describe(server: string, tool: PooledTool): McpToolDescriptor {
	return {
		server,
		tool: tool.name,
		name: `mcp__${server}__${tool.name}`,
		description: tool.description,
		inputSchema: tool.inputSchema,
		readOnly: tool.readOnly,
	};
}
