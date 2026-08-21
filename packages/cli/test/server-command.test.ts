import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHarnez } from "../../server/src/http-server";
import { VERSION } from "../../shared/src/version";
import { parseResume } from "../src/index";
import { dataDirectory, health, runServerCommand } from "../src/server-command";

const paths: string[] = [];

afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("CLI arguments", () => {
	test("stores user data in the XDG data directory", () => {
		const previous = process.env["XDG_DATA_HOME"];
		const data = join(tmpdir(), "harnez-xdg-data");
		process.env["XDG_DATA_HOME"] = data;
		try {
			expect(dataDirectory()).toBe(join(data, "harnez"));
		} finally {
			if (previous === undefined) delete process.env["XDG_DATA_HOME"];
			else process.env["XDG_DATA_HOME"] = previous;
		}
	});

	test("accepts only an optional resume id", () => {
		expect(parseResume([])).toBeUndefined();
		expect(parseResume(["--resume"])).toBe(true);
		expect(parseResume(["--resume", "session-1"])).toBe("session-1");
		expect(() => parseResume(["session-1"])).toThrow("Usage:");
	});

	test("rejects unknown server commands", async () => {
		await expect(runServerCommand(["reload"])).rejects.toThrow("Usage:");
		await expect(runServerCommand(["stop", "now"])).rejects.toThrow("Usage:");
	});

	/**
	 * Restarting a server Harnez did not spawn would stop something it cannot
	 * start again, so the refusal has to come before anything is signalled.
	 */
	test("never restarts a server reached through a configured URL", async () => {
		const previous = process.env["HARNEZ_URL"];
		process.env["HARNEZ_URL"] = "http://127.0.0.1:9";
		try {
			await expect(runServerCommand(["restart"])).rejects.toThrow(
				"cannot restart the server configured at",
			);
		} finally {
			if (previous === undefined) delete process.env["HARNEZ_URL"];
			else process.env["HARNEZ_URL"] = previous;
		}
	});

	test("restart reports when no server is running instead of starting one", async () => {
		const previous = process.env["HARNEZ_PORT"];
		process.env["HARNEZ_PORT"] = "9";
		try {
			await expect(runServerCommand(["restart"])).rejects.toThrow(
				"no Harnez server is running",
			);
		} finally {
			if (previous === undefined) delete process.env["HARNEZ_PORT"];
			else process.env["HARNEZ_PORT"] = previous;
		}
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
		const server = serveHarnez({
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
				version: VERSION,
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
