import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CapabilityCatalog } from "../src/capabilities/catalog";
import { mcpCapabilities } from "../src/mcp/capabilities";
import { MCP_SCHEMA_ID, type McpConfigScan, loadMcpConfig } from "../src/mcp/config";
import { McpConnectionPool } from "../src/mcp/pool";
import { McpRegistry, type McpRegistryOptions } from "../src/mcp/registry";

const FIXTURE = join(import.meta.dir, "fixtures/mcp-echo-server.ts");

const paths: string[] = [];
const registries: McpRegistry[] = [];
afterEach(async () => {
	await Promise.all(registries.splice(0).map((registry) => registry.close()));
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

/**
 * Builds a plugin-shaped directory whose `./bin/server` is a real executable, so
 * relative-command resolution and the spawn are both exercised for real.
 */
function pluginRoot(server: string = FIXTURE): string {
	const root = mkdtempSync(join(tmpdir(), "harnez-mcp-run-"));
	paths.push(root);
	mkdirSync(join(root, "bin"), { recursive: true });
	const launcher = join(root, "bin/server");
	// Each launch appends a line, so a shared connection is observable as one spawn.
	writeFileSync(
		launcher,
		`#!/bin/sh\necho started >> ${JSON.stringify(join(root, "spawns.log"))}\nexec bun ${JSON.stringify(server)} "$@"\n`,
	);
	chmodSync(launcher, 0o755);
	return root;
}

function spawns(root: string): number {
	try {
		return readFileSync(join(root, "spawns.log"), "utf8").trim().split("\n")
			.length;
	} catch {
		return 0;
	}
}

function registry(
	root: string,
	servers: Record<string, unknown>,
	options: Omit<McpRegistryOptions, "load"> = {},
): McpRegistry {
	writeFileSync(
		join(root, "mcp.json"),
		JSON.stringify({ $schema: MCP_SCHEMA_ID, mcpServers: servers }),
	);
	const load = (workspace: string): McpConfigScan =>
		loadMcpConfig(workspace, {
			sources: [{ path: join(root, "mcp.json"), root }],
			dataRoot: (name) => join(root, "state", name),
		});
	const created = new McpRegistry(root, { load, ...options });
	registries.push(created);
	return created;
}

test("connects a stdio server and honors the subprocess contract", async () => {
	const root = pluginRoot();
	const telemetryEnvironment = {
		OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
		OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],
		HARNEZ_OTEL: process.env["HARNEZ_OTEL"],
		HARNEZ_OTEL_CAPTURE_CONTENT: process.env["HARNEZ_OTEL_CAPTURE_CONTENT"],
		HARNEZ_OTEL_CAPTURE_MAX_CHARS:
			process.env["HARNEZ_OTEL_CAPTURE_MAX_CHARS"],
	};
	Object.assign(process.env, {
		OTEL_EXPORTER_OTLP_ENDPOINT: "http://secret.invalid",
		OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
		HARNEZ_OTEL: "1",
		HARNEZ_OTEL_CAPTURE_CONTENT: "prompts",
		HARNEZ_OTEL_CAPTURE_MAX_CHARS: "64",
	});
	process.env["HARNEZ_MCP_TEST_AMBIENT"] = "from-parent";
	const mcp = registry(root, {
		echo: {
			type: "stdio",
			command: "./bin/server",
			args: ["--data", "${PLUGIN_DATA}/store"],
			env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
			cwd: "${PLUGIN_DATA}",
		},
	});

	const snapshot = await mcp.snapshot();
	expect(snapshot.diagnostics).toEqual([]);
	expect(snapshot.tools.map((tool) => tool.name).toSorted()).toEqual([
		"mcp__echo__boom",
		"mcp__echo__launch_report",
		"mcp__echo__shout",
	]);

	const report = JSON.parse(
		await mcp.call("echo", "launch_report", {}, AbortSignal.timeout(20_000)),
	);
	expect(report.pluginRoot).toBe(root);
	expect(report.pluginData).toBe(join(root, "state/echo"));
	expect(report.argv).toEqual(["--data", join(root, "state/echo/store")]);
	expect(report.config).toBe(join(root, "config.json"));
	// PLUGIN_DATA is created before launch, so cwd resolves to a real directory.
	// The child reports its resolved path, which differs from the tmpdir symlink.
	expect(report.cwd).toBe(realpathSync(join(root, "state/echo")));
	// The ambient environment is inherited so secrets can stay out of mcp.json.
	expect(report.inherited).toBe("from-parent");
	expect(report.otelEndpoint).toBeNull();
	expect(report.otelHeaders).toBeNull();
	expect(report.harnezOtel).toBeNull();
	expect(report.captureContent).toBeNull();
	expect(report.captureMaxChars).toBeNull();
	delete process.env["HARNEZ_MCP_TEST_AMBIENT"];
	for (const [key, value] of Object.entries(telemetryEnvironment)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}, 30_000);

test("passes arguments through and surfaces tool errors as failures", async () => {
	const mcp = registry(pluginRoot(), {
		echo: { type: "stdio", command: "./bin/server" },
	});
	await mcp.snapshot();

	expect(
		await mcp.call("echo", "shout", { text: "hello" }, AbortSignal.timeout(20_000)),
	).toBe("HELLO");
	await expect(
		mcp.call("echo", "boom", {}, AbortSignal.timeout(20_000)),
	).rejects.toThrow("boom failed on purpose");
}, 30_000);

test("reports a server that cannot start and keeps the healthy ones", async () => {
	const root = pluginRoot();
	const mcp = registry(root, {
		broken: { type: "stdio", command: "./bin/missing" },
		echo: { type: "stdio", command: "./bin/server" },
	});

	const snapshot = await mcp.snapshot();
	expect(snapshot.tools.map((tool) => tool.server)).toEqual([
		"echo",
		"echo",
		"echo",
	]);
	expect(snapshot.diagnostics).toHaveLength(1);
	expect(snapshot.diagnostics[0]?.server).toBe("broken");
}, 30_000);

test("produces catalog entries a model can actually discover", async () => {
	const mcp = registry(pluginRoot(), {
		echo: { type: "stdio", command: "./bin/server" },
	});
	const snapshot = await mcp.snapshot();
	const generation = crypto.randomUUID();
	const catalog = new CapabilityCatalog(
		mcpCapabilities(snapshot.tools, generation),
		generation,
	);
	const listed = catalog
		.snapshot({
			tool: { maxLevel: "execute", confirmation: "none" },
			skill: { maxLevel: "activate" },
		})
		.list({ kind: "tool" });

	// Regression guard: `provider_untrusted` metadata would blank descriptions and
	// hide every one of these from discovery.
	expect(listed.items).toHaveLength(3);
	for (const item of listed.items) expect(item.description).not.toBe("");
	const report = listed.items.find(
		(item) => item.name === "mcp__echo__launch_report",
	);
	expect(report?.providerDisplayName).toBe("MCP server echo");

	// A server that advertises no description still yields a usable entry.
	const shout = listed.items.find((item) => item.name === "mcp__echo__shout");
	expect(shout?.description).toContain("shout");
}, 30_000);

test("marks read-only tools so they do not count as mutating effects", async () => {
	const mcp = registry(pluginRoot(), {
		echo: { type: "stdio", command: "./bin/server" },
	});
	const snapshot = await mcp.snapshot();
	const capabilities = mcpCapabilities(snapshot.tools, "generation");
	const effects = Object.fromEntries(
		capabilities.map((capability) => [capability.name, capability.effect]),
	);
	expect(effects["mcp__echo__launch_report"]).toBe("read_only");
	expect(effects["mcp__echo__shout"]).toBe("mutating");
}, 30_000);

test("skips a server that is switched off and connects it again on demand", async () => {
	const root = pluginRoot();
	const off = new Set(["echo"]);
	const mcp = registry(
		root,
		{ echo: { type: "stdio", command: "./bin/server" } },
		{ enabled: (server) => !off.has(server) },
	);

	// A disabled server is still listed, or the menu would have no way back.
	expect(await mcp.list()).toEqual([
		{
			name: "echo",
			scope: "project",
			transport: "stdio",
			enabled: false,
			connected: false,
			idle: false,
			tools: 0,
		},
	]);
	expect((await mcp.snapshot()).tools).toEqual([]);

	off.delete("echo");
	await mcp.setEnabled((server) => !off.has(server));
	const [status] = await mcp.list();
	expect(status?.enabled).toBe(true);
	expect(status?.connected).toBe(true);
	expect(status?.tools).toBe(3);
	expect((await mcp.snapshot()).tools).toHaveLength(3);

	// Switching it back off stops the child and withdraws its tools.
	await mcp.setEnabled(() => false);
	expect((await mcp.snapshot()).tools).toEqual([]);
	await expect(
		mcp.call("echo", "shout", { text: "hi" }, AbortSignal.timeout(5_000)),
	).rejects.toThrow("MCP server not connected: echo");
}, 30_000);

test("reports a failed server in the listing and clears it on a retry", async () => {
	const root = pluginRoot();
	const enabled = new Set<string>(["broken"]);
	const mcp = registry(
		root,
		{ broken: { type: "stdio", command: "./bin/missing" } },
		{ enabled: (server) => enabled.has(server) },
	);

	const [failed] = await mcp.list();
	expect(failed?.connected).toBe(false);
	expect(failed?.error).toContain("failed to connect");
	await expect(
		mcp.call("broken", "shout", {}, AbortSignal.timeout(5_000)),
	).rejects.toThrow("failed to connect");

	// Switching a broken server off retires the failure with it.
	enabled.delete("broken");
	await mcp.setEnabled((server) => enabled.has(server));
	const [disabled] = await mcp.list();
	expect(disabled?.error).toBeUndefined();
	expect((await mcp.snapshot()).diagnostics).toEqual([]);
}, 30_000);

test("revives a client after callTool rejects", async () => {
	const root = pluginRoot();
	const pool = new McpConnectionPool({ sweep: false });
	const mcp = registry(
		root,
		{ echo: { type: "stdio", command: "./bin/server" } },
		{ pool },
	);
	await mcp.snapshot();
	const aborted = new AbortController();
	aborted.abort();
	await expect(mcp.call("echo", "shout", {}, aborted.signal)).rejects.toThrow();

	expect(
		await mcp.call("echo", "shout", { text: "back" }, AbortSignal.timeout(20_000)),
	).toBe("BACK");
	expect(spawns(root)).toBe(2);
	await pool.close();
}, 30_000);

test("runs one child for the same server configured in two workspaces", async () => {
	const root = pluginRoot();
	const pool = new McpConnectionPool({ sweep: false });
	const entry = { echo: { type: "stdio", command: "./bin/server" } };
	const first = registry(root, entry, { pool });
	const second = registry(root, entry, { pool });

	expect((await first.snapshot()).tools).toHaveLength(3);
	expect((await second.snapshot()).tools).toHaveLength(3);
	expect(spawns(root)).toBe(1);

	// One workspace letting go must not take the tools away from the other.
	await first.setEnabled(() => false);
	expect(
		await second.call("echo", "shout", { text: "hi" }, AbortSignal.timeout(20_000)),
	).toBe("HI");
	expect(spawns(root)).toBe(1);

	// With no workspace left holding it, the child stops.
	await second.setEnabled(() => false);
	await expect(
		second.call("echo", "shout", { text: "hi" }, AbortSignal.timeout(5_000)),
	).rejects.toThrow("MCP server not connected: echo");
	await pool.close();
}, 30_000);

test("evicts an idle server, keeps its metadata, and revives it on a call", async () => {
	const root = pluginRoot();
	// Never swept on a timer: the test advances the clock itself.
	const pool = new McpConnectionPool({ idleMs: 60_000, sweep: false });
	const mcp = registry(
		root,
		{ echo: { type: "stdio", command: "./bin/server" } },
		{ pool },
	);
	await mcp.snapshot();
	expect(spawns(root)).toBe(1);

	pool.sweep(Date.now() + 60_001);
	const [idle] = await mcp.list();
	expect(idle?.idle).toBe(true);
	// The catalog still describes the server, so an eviction costs no capability.
	expect(idle?.connected).toBe(true);
	expect(idle?.tools).toBe(3);
	expect((await mcp.snapshot()).tools).toHaveLength(3);

	expect(
		await mcp.call("echo", "shout", { text: "back" }, AbortSignal.timeout(20_000)),
	).toBe("BACK");
	expect(spawns(root)).toBe(2);
	const [revived] = await mcp.list();
	expect(revived?.idle).toBe(false);
	await pool.close();
}, 30_000);

test("reports which file declared a server", async () => {
	const root = pluginRoot();
	writeFileSync(
		join(root, "mcp.json"),
		JSON.stringify({
			$schema: MCP_SCHEMA_ID,
			mcpServers: { echo: { type: "stdio", command: "./bin/server" } },
		}),
	);
	const created = new McpRegistry(root, {
		load: (workspace) =>
			loadMcpConfig(workspace, {
				sources: [
					{ path: join(root, "mcp.json"), root, scope: "global" },
				],
				dataRoot: (name) => join(root, "state", name),
			}),
	});
	registries.push(created);
	expect((await created.list())[0]?.scope).toBe("global");
}, 30_000);
