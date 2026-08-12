import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHarness } from "../../server/src/http-server";
import { parseResume } from "../src/index";
import { health, runServerCommand } from "../src/server-command";

const paths: string[] = [];

afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("CLI arguments", () => {
	test("accepts only an optional resume id", () => {
		expect(parseResume([])).toBeUndefined();
		expect(parseResume(["--resume", "session-1"])).toBe("session-1");
		expect(() => parseResume(["--resume"])).toThrow("Usage:");
		expect(() => parseResume(["session-1"])).toThrow("Usage:");
	});

	test("rejects unknown server commands", async () => {
		await expect(runServerCommand(["restart"])).rejects.toThrow("Usage:");
	});

	test("never signals a server reached through a remote URL", async () => {
		const previous = process.env["HARNEZ_URL"];
		process.env["HARNEZ_URL"] = "https://example.com";
		try {
			await expect(runServerCommand(["stop"])).rejects.toThrow(
				"only stop a local server",
			);
		} finally {
			if (previous === undefined) delete process.env["HARNEZ_URL"];
			else process.env["HARNEZ_URL"] = previous;
		}
	});

	test("allows an IPv6 loopback URL", async () => {
		const previous = process.env["HARNEZ_URL"];
		process.env["HARNEZ_URL"] = "http://[::1]:9";
		try {
			await expect(runServerCommand(["stop"])).resolves.toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env["HARNEZ_URL"];
			else process.env["HARNEZ_URL"] = previous;
		}
	});
});

describe("server health", () => {
	test("recognizes Harnez and rejects another service", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-cli-test-"));
		paths.push(dir);
		const server = serveHarness({
			port: 0,
			databasePath: join(dir, "state.sqlite"),
		});
		const other = Bun.serve({
			port: 0,
			fetch: () => Response.json({ name: "other", pid: process.pid }),
		});
		try {
			expect(await health(server.url.toString())).toEqual({
				name: "harnez",
				pid: process.pid,
			});
			await expect(health(other.url.toString())).rejects.toThrow(
				"not Harnez",
			);
		} finally {
			server.stop(true);
			other.stop(true);
		}
	});
});
