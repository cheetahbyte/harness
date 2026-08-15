import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { globalHarnezPath, projectHarnezPath } from "../settings-store";

/**
 * Harnez reads the MCP configuration format defined by Agent Plugins 1.0.0
 * (§7.2, §9) without adopting the surrounding plugin package model. Only the
 * schema is borrowed, so a later move to full plugin packages is a manifest
 * parser plus a different root/data pair handed to `resolveServers`.
 *
 * https://github.com/agentplugins/agent-plugins-spec/blob/main/spec/1.0.0.md
 */
export const MCP_SCHEMA_ID =
	"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/** Which file declared a server, so a menu can say where it came from. */
export type McpScope = "global" | "project";

export type ResolvedStdioServer = {
	name: string;
	scope: McpScope;
	transport: "stdio";
	command: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	pluginRoot: string;
	pluginData: string;
};
type ResolvedHttpServer = {
	name: string;
	scope: McpScope;
	transport: "streamable-http";
	url: string;
	headers: Record<string, string>;
};
export type ResolvedServer = ResolvedStdioServer | ResolvedHttpServer;

/**
 * Mirrors `SkillScan` so per-entry failure isolation (§7.2.2) reports the same
 * way skills already do: one bad entry never takes down the others.
 */
export type McpDiagnostic = {
	path: string;
	server?: string;
	state: "invalid" | "unreadable" | "unsupported";
	error: string;
};
export type McpConfigScan = {
	servers: ResolvedServer[];
	diagnostics: McpDiagnostic[];
};

type ConfigSource = {
	/** The `mcp.json` itself. */
	path: string;
	/** `PLUGIN_ROOT`: the directory holding it, which becomes the plugin root later. */
	root: string;
	/** Defaults to `project`, the scope a caller-supplied source usually models. */
	scope?: McpScope;
};

/**
 * Global first, project second: later sources win, matching how `SettingsStore`
 * layers project settings over global ones.
 */
function mcpConfigSources(workspace: string): ConfigSource[] {
	const global = globalHarnezPath("mcp.json");
	const paths = [global, projectHarnezPath("mcp.json", workspace)];
	return [...new Set(paths)].map((path) => ({
		path,
		root: dirname(path),
		scope: path === global ? ("global" as const) : ("project" as const),
	}));
}

/** `PLUGIN_DATA` (§9.1): client-managed, per-server, outlives package contents. */
function defaultDataRoot(server: string): string {
	return globalHarnezPath(join("mcp-data", server));
}

export function loadMcpConfig(
	workspace: string,
	options: {
		sources?: readonly ConfigSource[];
		dataRoot?: (server: string) => string;
	} = {},
): McpConfigScan {
	const dataRoot = options.dataRoot ?? defaultDataRoot;
	const result: McpConfigScan = { servers: [], diagnostics: [] };
	const byName = new Map<string, ResolvedServer>();
	for (const source of options.sources ?? mcpConfigSources(workspace)) {
		const scan = loadSource(source, dataRoot);
		result.diagnostics.push(...scan.diagnostics);
		for (const server of scan.servers) byName.set(server.name, server);
	}
	result.servers = [...byName.values()].toSorted((a, b) =>
		a.name.localeCompare(b.name),
	);
	return result;
}

function loadSource(
	source: ConfigSource,
	dataRoot: (server: string) => string,
): McpConfigScan {
	const result: McpConfigScan = { servers: [], diagnostics: [] };
	let raw: string;
	try {
		raw = readFileSync(source.path, "utf8");
	} catch (error) {
		// An absent config is the normal case; anything else is worth reporting.
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			result.diagnostics.push({
				path: source.path,
				state: "unreadable",
				error: message(error),
			});
		return result;
	}
	let document: unknown;
	try {
		document = JSON.parse(raw);
	} catch (error) {
		result.diagnostics.push({
			path: source.path,
			state: "invalid",
			error: `mcp.json is not valid JSON: ${message(error)}`,
		});
		return result;
	}
	const servers = validateDocument(document);
	if (typeof servers === "string") {
		// A malformed file disables MCP for that source only (§7.2.2.2).
		result.diagnostics.push({
			path: source.path,
			state: "invalid",
			error: servers,
		});
		return result;
	}
	for (const [name, entry] of servers) {
		const resolved = resolveServer(
			name,
			entry,
			source.root,
			source.scope ?? "project",
			dataRoot,
		);
		if (typeof resolved === "string")
			result.diagnostics.push({
				path: source.path,
				server: name,
				state: resolved.startsWith("unsupported") ? "unsupported" : "invalid",
				error: resolved,
			});
		else result.servers.push(resolved);
	}
	return result;
}

/**
 * The file-level contract (§7.2.1). `$schema` is a version discriminator matched
 * by exact string compare — the spec forbids retrieving it while loading.
 */
function validateDocument(
	document: unknown,
): [string, Record<string, unknown>][] | string {
	if (!isRecord(document)) return "mcp.json must contain a JSON object";
	const unknown = Object.keys(document).filter(
		(key) => key !== "$schema" && key !== "mcpServers",
	);
	if (unknown.length)
		return `unknown top-level field(s): ${unknown.join(", ")}`;
	if (!("$schema" in document)) return "missing required field: $schema";
	if (document["$schema"] !== MCP_SCHEMA_ID)
		return `unsupported MCP configuration schema: ${String(document["$schema"])}`;
	if (!("mcpServers" in document)) return "missing required field: mcpServers";
	const servers = document["mcpServers"];
	if (!isRecord(servers)) return "mcpServers must be an object";
	const entries: [string, Record<string, unknown>][] = [];
	for (const [name, entry] of Object.entries(servers)) {
		if (!isRecord(entry)) return `server ${name} must be an object`;
		entries.push([name, entry]);
	}
	return entries;
}

/**
 * Agent Plugins puts no constraint on server names, but harnez folds them into
 * tool names (`mcp__<server>__<tool>`), so a name that would produce an
 * unusable tool identifier is rejected and reported rather than mangled.
 */
const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/;

function resolveServer(
	name: string,
	entry: Record<string, unknown>,
	root: string,
	scope: McpScope,
	dataRoot: (server: string) => string,
): ResolvedServer | string {
	if (!SERVER_NAME.test(name))
		return `server name must be alphanumeric with . or - separators`;
	const type = entry["type"];
	if (type === "stdio")
		return resolveStdio(name, entry, root, scope, dataRoot(name));
	if (type === "streamable-http") return resolveHttp(name, entry, scope, type);
	if (type === "sse")
		// Supporting `sse` is OPTIONAL; skipping the entry is conformant (§7.2.2.4).
		return "unsupported transport: sse";
	return `unknown or missing server type: ${String(type)}`;
}

const STDIO_FIELDS = new Set(["type", "command", "args", "env", "cwd"]);

function resolveStdio(
	name: string,
	entry: Record<string, unknown>,
	root: string,
	scope: McpScope,
	data: string,
): ResolvedStdioServer | string {
	const unknown = Object.keys(entry).filter((key) => !STDIO_FIELDS.has(key));
	if (unknown.length) return `unknown stdio field(s): ${unknown.join(", ")}`;

	const command = entry["command"];
	if (typeof command !== "string" || !command)
		return "command must be a non-empty string";
	// `command` is one token and is never expanded (§7.2.1): a bare name goes to
	// the platform search, `./x` resolves against the root and must stay inside.
	let resolvedCommand: string;
	if (command.startsWith("./")) {
		const absolute = resolve(root, command);
		if (!contained(root, absolute)) return "command escapes the config root";
		resolvedCommand = absolute;
	} else if (
		isAbsolute(command) ||
		command.includes("/") ||
		command.includes("\\") ||
		// Whitespace means a shell command string, which is never one token.
		/\s/.test(command)
	)
		return "command must be a bare executable name or start with ./";
	else resolvedCommand = command;

	const args: string[] = [];
	if (entry["args"] !== undefined) {
		if (!Array.isArray(entry["args"])) return "args must be an array";
		for (const value of entry["args"]) {
			if (typeof value !== "string") return "args must contain only strings";
			args.push(expand(value, root, data));
		}
	}

	const env: Record<string, string> = {};
	if (entry["env"] !== undefined) {
		if (!isRecord(entry["env"])) return "env must be an object";
		for (const [key, value] of Object.entries(entry["env"])) {
			// The client owns these two; a config that sets them is invalid (§9.2).
			if (key === "PLUGIN_ROOT" || key === "PLUGIN_DATA")
				return `env must not declare the reserved variable ${key}`;
			if (typeof value !== "string")
				return "env must contain only string values";
			env[key] = expand(value, root, data);
		}
	}

	const cwd = resolveCwd(entry["cwd"], root, data);
	if (typeof cwd === "object") return cwd.error;

	return {
		name,
		scope,
		transport: "stdio",
		command: resolvedCommand,
		args,
		env,
		cwd,
		pluginRoot: root,
		pluginData: data,
	};
}

/**
 * Three permitted forms (§7.2.1), each confined to the root it names. Omitting
 * `cwd` means the plugin root.
 */
function resolveCwd(
	value: unknown,
	root: string,
	data: string,
): string | { error: string } {
	if (value === undefined) return root;
	if (typeof value !== "string") return { error: "cwd must be a string" };
	const anchor = value.startsWith("${PLUGIN_DATA}")
		? data
		: value.startsWith("${PLUGIN_ROOT}") || value.startsWith("./")
			? root
			: undefined;
	if (!anchor)
		return {
			error: "cwd must start with ./, ${PLUGIN_ROOT}, or ${PLUGIN_DATA}",
		};
	// A `${…}`-rooted value expands to an absolute path, which wins; a `./` value
	// still needs the anchor, or it would resolve against the process cwd.
	const absolute = resolve(anchor, expand(value, root, data));
	if (!contained(anchor, absolute))
		return { error: "cwd escapes its configured root" };
	return absolute;
}

const HTTP_FIELDS = new Set(["type", "url", "headers"]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function resolveHttp(
	name: string,
	entry: Record<string, unknown>,
	scope: McpScope,
	transport: "streamable-http",
): ResolvedHttpServer | string {
	const unknown = Object.keys(entry).filter((key) => !HTTP_FIELDS.has(key));
	if (unknown.length)
		return `unknown ${transport} field(s): ${unknown.join(", ")}`;
	const raw = entry["url"];
	if (typeof raw !== "string" || !raw) return "url must be a non-empty string";
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return `url must be an absolute URL: ${raw}`;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		return `url must use http or https: ${raw}`;
	if (url.username || url.password)
		return "url must not contain user information";
	if (url.hash) return "url must not contain a fragment";
	// Plaintext is only tolerated when it cannot leave the machine (§7.2.1).
	if (url.protocol === "http:" && !isLoopback(url.hostname))
		return "url must use https for non-loopback hosts";

	const headers: Record<string, string> = {};
	if (entry["headers"] !== undefined) {
		if (!isRecord(entry["headers"])) return "headers must be an object";
		const seen = new Set<string>();
		for (const [key, value] of Object.entries(entry["headers"])) {
			if (!HEADER_NAME.test(key)) return `invalid header name: ${key}`;
			const lower = key.toLowerCase();
			if (seen.has(lower)) return `duplicate header name: ${key}`;
			seen.add(lower);
			if (typeof value !== "string")
				return "headers must contain only string values";
			if (/[\r\n\0]/.test(value)) return `invalid header value for ${key}`;
			// No expansion in url or headers (§9.2) — values are used verbatim.
			headers[key] = value;
		}
	}
	return { name, scope, transport, url: url.toString(), headers };
}

function isLoopback(hostname: string): boolean {
	if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1")
		return true;
	const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
	return !!ipv4 && ipv4[1] === "127";
}

/**
 * One non-recursive pass (§9.2). A global regex replace scans the original
 * string only, so a replacement that itself contains `${PLUGIN_DATA}` is left
 * alone, and unrecognized placeholder-like text stays literal.
 */
function expand(value: string, root: string, data: string): string {
	return value.replace(/\$\{(PLUGIN_ROOT|PLUGIN_DATA)\}/g, (_match, name) =>
		name === "PLUGIN_ROOT" ? root : data,
	);
}

/**
 * Containment is filesystem-resolved (§4.1), so symlinks may point inside the
 * root but never out of it. Paths that do not exist yet are checked lexically.
 */
function contained(root: string, absolute: string): boolean {
	return within(root, absolute) && within(real(root), real(absolute));
}

function within(root: string, absolute: string): boolean {
	const offset = relative(root, absolute);
	return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

/**
 * `realpathSync` needs the path to exist, but a configured command or working
 * directory legitimately may not yet. Resolving the nearest existing ancestor
 * and reattaching the remainder keeps symlinked roots (`/tmp` on macOS) and
 * symlinked leaves comparable on the same terms.
 */
function real(path: string): string {
	let existing = path;
	const tail: string[] = [];
	while (!existsSync(existing)) {
		const parent = dirname(existing);
		if (parent === existing) return path;
		tail.unshift(existing.slice(parent.length + 1));
		existing = parent;
	}
	return join(realpathSync(existing), ...tail);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
