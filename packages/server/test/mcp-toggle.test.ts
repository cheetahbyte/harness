import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { McpServerOption, ServerEvent } from "../../shared/src/protocol";
import { MCP_SCHEMA_ID } from "../src/mcp/config";
import { HarnezServer } from "../src/server";
import { SessionStore } from "../src/sessions/store";
import { SettingsStore } from "../src/settings-store";

const FIXTURE = join(import.meta.dir, "fixtures/mcp-echo-server.ts");

const paths: string[] = [];
const servers: HarnezServer[] = [];
const originalConfigHome = process.env["XDG_CONFIG_HOME"];
afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.close()));
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
	if (originalConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
	else process.env["XDG_CONFIG_HOME"] = originalConfigHome;
});

/**
 * A workspace whose `.harnez` holds both the MCP configuration and the launcher
 * it names, so the toggle is exercised against a server that really starts.
 */
function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "harnez-mcp-toggle-"));
	paths.push(root);
	process.env["XDG_CONFIG_HOME"] = join(root, "config");
	const harnez = join(root, ".harnez");
	mkdirSync(join(harnez, "bin"), { recursive: true });
	const launcher = join(harnez, "bin/server");
	writeFileSync(
		launcher,
		`#!/bin/sh\nexec bun ${JSON.stringify(FIXTURE)} "$@"\n`,
	);
	chmodSync(launcher, 0o755);
	writeFileSync(
		join(harnez, "mcp.json"),
		JSON.stringify({
			$schema: MCP_SCHEMA_ID,
			mcpServers: { echo: { type: "stdio", command: "./bin/server" } },
		}),
	);
	return root;
}

function harnez(root: string): HarnezServer {
	const server = new HarnezServer(
		new SessionStore(join(root, "state.sqlite")),
		root,
		undefined,
		new SettingsStore(
			join(root, "config/settings.json"),
			join(root, ".harnez/settings.json"),
		),
	);
	servers.push(server);
	return server;
}

function listings(events: ServerEvent[]): McpServerOption[][] {
	return events
		.filter((event) => event.type === "mcp-servers")
		.map((event) => (event as { servers: McpServerOption[] }).servers);
}

test("lists MCP servers and switches one off and on again", async () => {
	const root = workspace();
	const server = harnez(root);
	const id = server.createSession();
	const events: ServerEvent[] = [];
	server.subscribe(id, (event) => events.push(event));

	await server.command(id, { type: "list-mcp-servers" });
	const [connected] = listings(events).at(-1) ?? [];
	expect(connected?.name).toBe("echo");
	expect(connected?.transport).toBe("stdio");
	expect(connected?.enabled).toBe(true);
	expect(connected?.connected).toBe(true);
	expect(connected?.tools).toBe(3);
	expect(connected?.tokens).toBeGreaterThan(0);

	// An empty selection switches off every server the menu listed.
	await server.command(id, { type: "set-mcp-enabled", servers: [] });
	const [off] = listings(events).at(-1) ?? [];
	expect(off?.enabled).toBe(false);
	expect(off?.connected).toBe(false);
	expect(off?.tools).toBe(0);
	// The exclusion is persisted, so the next process starts without the server.
	expect(
		JSON.parse(readFileSync(join(root, "config/settings.json"), "utf8")),
	).toMatchObject({ disabledMcpServers: ["echo"] });

	await server.command(id, { type: "set-mcp-enabled", servers: ["echo"] });
	const [on] = listings(events).at(-1) ?? [];
	expect(on?.enabled).toBe(true);
	expect(on?.connected).toBe(true);
	expect(on?.tools).toBe(3);
	expect(
		JSON.parse(readFileSync(join(root, "config/settings.json"), "utf8")),
	).toMatchObject({ disabledMcpServers: [] });
}, 30_000);

test("does not connect a server that settings switched off before startup", async () => {
	const root = workspace();
	mkdirSync(join(root, "config"), { recursive: true });
	writeFileSync(
		join(root, "config/settings.json"),
		JSON.stringify({ disabledMcpServers: ["echo"] }),
	);
	const server = harnez(root);
	const id = server.createSession();
	const events: ServerEvent[] = [];
	server.subscribe(id, (event) => events.push(event));

	await server.command(id, { type: "list-mcp-servers" });
	const [status] = listings(events).at(-1) ?? [];
	expect(status?.enabled).toBe(false);
	expect(status?.connected).toBe(false);
	expect(status?.tools).toBe(0);
}, 30_000);
