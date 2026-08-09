import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serveHarness } from "../src/server";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("HTTP event stream", () => {
	test("stays connected past Bun's default idle timeout", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-http-test-"));
		paths.push(dir);
		const server = serveHarness({
			port: 0,
			workspace: dir,
			databasePath: join(dir, "state.sqlite"),
		});
		try {
			const base = server.url.toString().replace(/\/$/, "");
			const { sessionId } = (await (
				await fetch(`${base}/sessions`, { method: "POST" })
			).json()) as { sessionId: string };
			const response = await fetch(`${base}/sessions/${sessionId}/events`);
			const reader = response.body?.getReader();
			expect((await reader.read()).done).toBe(false);
			await new Promise((resolve) => setTimeout(resolve, 10_250));
			await fetch(`${base}/sessions/${sessionId}/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "prompt", text: "/read missing" }),
			});
			const result = await reader.read();
			expect(result.done).toBe(false);
		} finally {
			server.stop(true);
		}
	}, 15_000);
});
