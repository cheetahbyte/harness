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
	test("exposes context lifecycle inspection without payloads", async () => {
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
			const inspection = (await (
				await fetch(`${base}/sessions/${sessionId}/context`)
			).json()) as Record<string, unknown>;
			expect(inspection).toMatchObject({
				sessionId,
				budget: 80_000,
				target: 64_000,
				counts: { pinned: 0, active: 0, retained: 0, archived: 0 },
				episodes: [],
				items: [],
			});
			expect(inspection.estimatedTokens).toBeGreaterThan(0);
			expect(JSON.stringify(inspection)).not.toContain("payload");
		} finally {
			server.stop(true);
		}
	});

	test("accepts a fake subagent handoff without importing its trace", async () => {
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
			const fake = stubSubagentHandoff();
			const response = await fetch(
				`${base}/sessions/${sessionId}/subagent-results`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						subagentId: fake.subagentId,
						result: fake.result,
					}),
				},
			);
			expect(response.status).toBe(201);
			const handoff = (await response.json()) as {
				payload: { artifactRefs: string[] };
			};
			expect(handoff.payload.artifactRefs).toEqual(["subagent://child-1"]);
			expect(JSON.stringify(handoff)).not.toContain(fake.childTrace);
			const inspection = (await (
				await fetch(`${base}/sessions/${sessionId}/context`)
			).json()) as { counts: Record<string, number>; items: { kind: string }[] };
			expect(inspection.counts).toMatchObject({ retained: 1, archived: 0 });
			expect(inspection.items.map((item) => item.kind)).toEqual([
				"subagent-handoff",
			]);
			const rejected = await fetch(
				`${base}/sessions/${sessionId}/subagent-results`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						subagentId: fake.subagentId,
						result: fake.result,
						trace: fake.childTrace,
					}),
				},
			);
			expect(rejected.status).toBe(404);
			expect(await rejected.json()).toEqual({
				error: "subagent traces must remain external",
			});
			const invalid = await fetch(
				`${base}/sessions/${sessionId}/subagent-results`,
				{
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						subagentId: fake.subagentId,
						result: { ...fake.result, status: "unknown" },
					}),
				},
			);
			expect(invalid.status).toBe(404);
			expect(await invalid.json()).toEqual({
				error: "invalid subagent status",
			});
		} finally {
			server.stop(true);
		}
	});

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
			if (!response.body) throw new Error("event stream response has no body");
      const reader = response.body.getReader();
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

function stubSubagentHandoff() {
	return {
		subagentId: "child-1",
		childTrace: "CHILD_TRACE_SENTINEL",
		result: {
			status: "completed" as const,
			findings: ["found the boundary"],
			decisions: [],
			changedFiles: [],
			verification: ["tests pass"],
			unresolvedIssues: [],
			artifactRefs: ["subagent://child-1"],
		},
	};
}
