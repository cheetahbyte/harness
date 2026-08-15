import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	loadMcpConfig,
	MCP_SCHEMA_ID,
	type McpConfigScan,
	type ResolvedStdioServer,
} from "../src/mcp/config";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function root(): string {
	const path = mkdtempSync(join(tmpdir(), "harnez-mcp-"));
	paths.push(path);
	return path;
}

/** Writes one `mcp.json` and scans it with a predictable PLUGIN_DATA root. */
function scan(
	dir: string,
	servers: Record<string, unknown>,
	document?: Record<string, unknown>,
): McpConfigScan {
	writeFileSync(
		join(dir, "mcp.json"),
		JSON.stringify(document ?? { $schema: MCP_SCHEMA_ID, mcpServers: servers }),
	);
	return loadMcpConfig(dir, {
		sources: [{ path: join(dir, "mcp.json"), root: dir }],
		dataRoot: (server) => join(dir, "data", server),
	});
}

/** Every negative case pairs the bad entry with a good one that must survive. */
const good = { type: "stdio", command: "node" };

function stdio(result: McpConfigScan, name: string): ResolvedStdioServer {
	const server = result.servers.find((candidate) => candidate.name === name);
	if (!server || server.transport !== "stdio")
		throw new Error(`no stdio server ${name} in ${JSON.stringify(result)}`);
	return server;
}

test("resolves the spec's example configuration", () => {
	const dir = root();
	mkdirSync(join(dir, "bin"), { recursive: true });
	writeFileSync(join(dir, "bin/validator"), "#!/bin/sh\n");
	const result = scan(dir, {
		validator: {
			type: "stdio",
			command: "./bin/validator",
			args: ["--data", "${PLUGIN_DATA}/validator"],
			env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
			cwd: "${PLUGIN_ROOT}",
		},
		"deployment-api": {
			type: "streamable-http",
			url: "https://deploy.example.com/mcp",
			headers: { "X-Tenant": "public-tenant" },
		},
	});

	expect(result.diagnostics).toEqual([]);
	const validator = stdio(result, "validator");
	expect(validator.command).toBe(join(dir, "bin/validator"));
	expect(validator.args).toEqual(["--data", join(dir, "data/validator/validator")]);
	expect(validator.env).toEqual({ CONFIG: join(dir, "config.json") });
	expect(validator.cwd).toBe(dir);
	expect(result.servers.map((server) => server.name)).toEqual([
		"deployment-api",
		"validator",
	]);
});

test("rejects a file whose schema identifier is not the supported version", () => {
	const dir = root();
	const result = scan(dir, {}, {
		$schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json",
		mcpServers: { good },
	});
	expect(result.servers).toEqual([]);
	expect(result.diagnostics[0]?.error).toContain("unsupported MCP configuration");
});

test("rejects a file carrying an unknown top-level field", () => {
	const dir = root();
	const result = scan(dir, {}, {
		$schema: MCP_SCHEMA_ID,
		mcpServers: { good },
		extra: true,
	});
	expect(result.servers).toEqual([]);
	expect(result.diagnostics[0]?.error).toContain("unknown top-level field(s)");
});

test("skips invalid entries and keeps the rest of the file loading", () => {
	const cases: Record<string, [unknown, string]> = {
		unknownField: [{ type: "stdio", command: "node", shell: true }, "unknown stdio field"],
		crossVariant: [{ type: "stdio", command: "node", url: "https://x.dev" }, "unknown stdio field"],
		unknownType: [{ type: "websocket", url: "wss://x.dev" }, "unknown or missing server type"],
		escapingCommand: [{ type: "stdio", command: "../evil" }, "bare executable name"],
		absoluteCommand: [{ type: "stdio", command: "/usr/bin/node" }, "bare executable name"],
		shellCommand: [{ type: "stdio", command: "node server.js --port 1" }, "bare executable name"],
		escapingCwd: [{ type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}/../out" }, "escapes its configured root"],
		bareCwd: [{ type: "stdio", command: "node", cwd: "data" }, "cwd must start with"],
		reservedRoot: [{ type: "stdio", command: "node", env: { PLUGIN_ROOT: "/tmp" } }, "reserved variable PLUGIN_ROOT"],
		reservedData: [{ type: "stdio", command: "node", env: { PLUGIN_DATA: "/tmp" } }, "reserved variable PLUGIN_DATA"],
		plainHttp: [{ type: "streamable-http", url: "http://deploy.example.com/mcp" }, "https for non-loopback"],
		userInfo: [{ type: "streamable-http", url: "https://user:pw@x.dev/mcp" }, "user information"],
		fragment: [{ type: "streamable-http", url: "https://x.dev/mcp#frag" }, "fragment"],
		duplicateHeader: [
			{ type: "streamable-http", url: "https://x.dev/mcp", headers: { "X-A": "1", "x-a": "2" } },
			"duplicate header name",
		],
	};

	for (const [name, [entry, expected]] of Object.entries(cases)) {
		const result = scan(root(), { [name]: entry, good });
		expect(result.servers.map((server) => server.name)).toEqual(["good"]);
		expect(result.diagnostics).toHaveLength(1);
		expect(result.diagnostics[0]?.server).toBe(name);
		expect(result.diagnostics[0]?.error).toContain(expected);
	}
});

test("reports sse as unsupported without disturbing other servers", () => {
	const result = scan(root(), {
		legacy: { type: "sse", url: "https://legacy.example.com/sse" },
		good,
	});
	expect(result.servers.map((server) => server.name)).toEqual(["good"]);
	expect(result.diagnostics[0]?.state).toBe("unsupported");
});

test("allows plaintext http only for loopback hosts", () => {
	const result = scan(root(), {
		local: { type: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
		named: { type: "streamable-http", url: "http://localhost:3000/mcp" },
	});
	expect(result.diagnostics).toEqual([]);
	expect(result.servers).toHaveLength(2);
});

test("expands only the two reserved variables, in a single pass", () => {
	const dir = root();
	const result = scan(dir, {
		server: {
			type: "stdio",
			command: "node",
			args: ["${PLUGIN_ROOT}", "${HOME}", "$PLUGIN_ROOT", "${PLUGIN_ROOT}${PLUGIN_DATA}"],
			env: { "${PLUGIN_ROOT}": "${PLUGIN_DATA}" },
		},
	});

	const server = stdio(result, "server");
	// Unrecognized placeholder-like text stays literal; env keys are never expanded.
	expect(server.args).toEqual([
		dir,
		"${HOME}",
		"$PLUGIN_ROOT",
		`${dir}${join(dir, "data/server")}`,
	]);
	expect(server.env).toEqual({ "${PLUGIN_ROOT}": join(dir, "data/server") });
});

test("does not rescan text introduced by an expansion", () => {
	const dir = root();
	const result = loadMcpConfig(dir, {
		sources: [{ path: join(dir, "mcp.json"), root: dir }],
		// A data root that itself looks like a placeholder must survive verbatim.
		dataRoot: () => "${PLUGIN_ROOT}",
	});
	writeFileSync(
		join(dir, "mcp.json"),
		JSON.stringify({
			$schema: MCP_SCHEMA_ID,
			mcpServers: { server: { type: "stdio", command: "node", args: ["${PLUGIN_DATA}"] } },
		}),
	);
	const rescanned = loadMcpConfig(dir, {
		sources: [{ path: join(dir, "mcp.json"), root: dir }],
		dataRoot: () => "${PLUGIN_ROOT}",
	});
	expect(result.servers).toEqual([]);
	expect(stdio(rescanned, "server").args).toEqual(["${PLUGIN_ROOT}"]);
});

test("rejects a command symlinked out of the config root", () => {
	const dir = root();
	const outside = root();
	writeFileSync(join(outside, "evil"), "#!/bin/sh\n");
	mkdirSync(join(dir, "bin"), { recursive: true });
	symlinkSync(join(outside, "evil"), join(dir, "bin/escape"));

	const result = scan(dir, { escape: { type: "stdio", command: "./bin/escape" }, good });
	expect(result.servers.map((server) => server.name)).toEqual(["good"]);
	expect(result.diagnostics[0]?.error).toContain("escapes the config root");
});

test("lets project configuration override a global server of the same name", () => {
	const globalDir = root();
	const projectDir = root();
	for (const [dir, command] of [
		[globalDir, "global-command"],
		[projectDir, "project-command"],
	] as const)
		writeFileSync(
			join(dir, "mcp.json"),
			JSON.stringify({
				$schema: MCP_SCHEMA_ID,
				mcpServers: { shared: { type: "stdio", command } },
			}),
		);

	const result = loadMcpConfig(projectDir, {
		sources: [
			{ path: join(globalDir, "mcp.json"), root: globalDir },
			{ path: join(projectDir, "mcp.json"), root: projectDir },
		],
		dataRoot: (server) => join(projectDir, "data", server),
	});
	expect(result.servers).toHaveLength(1);
	expect(stdio(result, "shared").command).toBe("project-command");
});

test("treats a missing configuration as normal and malformed JSON as reportable", () => {
	const dir = root();
	expect(
		loadMcpConfig(dir, { sources: [{ path: join(dir, "mcp.json"), root: dir }] }),
	).toEqual({ servers: [], diagnostics: [] });

	writeFileSync(join(dir, "mcp.json"), "{not json");
	const broken = loadMcpConfig(dir, {
		sources: [{ path: join(dir, "mcp.json"), root: dir }],
	});
	expect(broken.servers).toEqual([]);
	expect(broken.diagnostics[0]?.error).toContain("not valid JSON");
});
