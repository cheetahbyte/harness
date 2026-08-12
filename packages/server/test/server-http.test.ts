import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamLine } from "../../shared/src/protocol";
import { serveHarness } from "../src/http-server";
import { HarnessServer } from "../src/server";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

/** Reads exactly `count` stream lines, ignoring heartbeat blanks. */
async function readLines(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	count: number,
): Promise<StreamLine[]> {
	const decoder = new TextDecoder();
	const lines: StreamLine[] = [];
	let pending = "";
	while (lines.length < count) {
		const next = await reader.read();
		if (next.done) throw new Error("stream ended early");
		pending += decoder.decode(next.value, { stream: true });
		const parts = pending.split("\n");
		pending = parts.pop() ?? "";
		for (const part of parts)
			if (part) lines.push(JSON.parse(part) as StreamLine);
	}
	return lines;
}

describe("HTTP event stream", () => {
	test("reports its Harnez health", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-http-test-"));
		paths.push(dir);
		const server = serveHarness({
			port: 0,
			workspace: dir,
			databasePath: join(dir, "state.sqlite"),
		});
		try {
			const base = server.url.toString().replace(/\/$/, "");
			const health = await fetch(`${base}/health`);
			expect(health.status).toBe(200);
			expect(await health.json()).toEqual({ name: "harnez", pid: process.pid });
		} finally {
			server.stop(true);
		}
	});

	test("creates a session in its requested workspace", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-http-test-"));
		paths.push(dir);
		const server = serveHarness({
			port: 0,
			workspace: dir,
			databasePath: join(dir, "state.sqlite"),
		});
		try {
			const base = server.url.toString().replace(/\/$/, "");
			const created = await fetch(`${base}/sessions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd: dir }),
			});
			expect(created.status).toBe(200);
			const missing = await fetch(`${base}/sessions/missing/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "prompt", text: "hello" }),
			});
			expect(missing.status).toBe(404);
			const invalid = await fetch(`${base}/sessions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ cwd: join(dir, "missing") }),
			});
			expect(invalid.status).toBe(400);
		} finally {
			server.stop(true);
		}
	});

	test("lists only messaged sessions, newest first", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-http-test-"));
		paths.push(dir);
		const server = serveHarness({
			port: 0,
			workspace: dir,
			databasePath: join(dir, "state.sqlite"),
		});
		try {
			const base = server.url.toString().replace(/\/$/, "");
			const create = async () =>
				((await (
					await fetch(`${base}/sessions`, { method: "POST" })
				).json()) as { sessionId: string }).sessionId;
			const first = await create();
			await Bun.sleep(2);
			const second = await create();

			expect(await (await fetch(`${base}/sessions`)).json()).toEqual([]);
			for (const sessionId of [first, second])
				await fetch(`${base}/sessions/${sessionId}/commands`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ type: "enqueue", text: "hello" }),
				});

			const response = await fetch(`${base}/sessions`);
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual([
				{
					id: second,
					createdAt: expect.any(String),
					workspace: dir,
					title: null,
				},
				{
					id: first,
					createdAt: expect.any(String),
					workspace: dir,
					title: null,
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	test("responds before a command finishes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-http-test-"));
		paths.push(dir);
		let release!: () => void;
		const pending = new Promise<void>((resolve) => (release = resolve));
		const command = HarnessServer.prototype.command;
		HarnessServer.prototype.command = async () => pending;
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
			const response = await Promise.race([
				fetch(`${base}/sessions/${sessionId}/commands`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ type: "prompt", text: "hello" }),
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("command response timed out")), 250),
				),
			]);
			expect(response.status).toBe(202);
		} finally {
			release();
			HarnessServer.prototype.command = command;
			server.stop(true);
		}
	});

	test("publishes detached command failures", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-http-test-"));
		paths.push(dir);
		const command = HarnessServer.prototype.command;
		HarnessServer.prototype.command = async () => {
			throw new Error("expected command failure");
		};
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
			const events = await fetch(`${base}/sessions/${sessionId}/events`);
			if (!events.body) throw new Error("event stream response has no body");
			const reader = events.body.getReader();
			await reader.read();
			expect(
				(
					await fetch(`${base}/sessions/${sessionId}/commands`, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ type: "prompt", text: "hello" }),
					})
				).status,
			).toBe(202);
			const line = JSON.parse(
				new TextDecoder().decode((await reader.read()).value),
			) as StreamLine;
			expect(line.event).toEqual({
				type: "error",
				message: "expected command failure",
			});
			expect(line.seq).toBeGreaterThan(0);
			await reader.cancel();
		} finally {
			HarnessServer.prototype.command = command;
			server.stop(true);
		}
	});

	test("resumes after a cursor without replaying earlier events", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-http-test-"));
		paths.push(dir);
		let failures = 0;
		const command = HarnessServer.prototype.command;
		HarnessServer.prototype.command = async () => {
			throw new Error(`failure ${++failures}`);
		};
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
			for (let index = 0; index < 3; index++)
				await fetch(`${base}/sessions/${sessionId}/commands`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ type: "prompt", text: "hello" }),
				});
			// Commands are detached, so wait for all three failures to be persisted.
			while (
				(
					(await (await fetch(`${base}/sessions/${sessionId}`)).json()) as {
						events: unknown[];
					}
				).events.length < 3
			)
				await new Promise((resolve) => setTimeout(resolve, 10));

			const first = await fetch(`${base}/sessions/${sessionId}/events`);
			if (!first.body) throw new Error("event stream response has no body");
			const firstReader = first.body.getReader();
			const replayed = await readLines(firstReader, 4);
			expect(replayed[0]?.event.type).toBe("session");
			const sequenced = replayed.filter((line) => line.seq !== undefined);
			expect(sequenced.map((line) => line.event)).toEqual([
				{ type: "error", message: "failure 1" },
				{ type: "error", message: "failure 2" },
				{ type: "error", message: "failure 3" },
			]);
			await firstReader.cancel();

			// Resuming after the second event must deliver only the third.
			const resumed = await fetch(
				`${base}/sessions/${sessionId}/events?from=${sequenced[1]?.seq}`,
			);
			if (!resumed.body) throw new Error("event stream response has no body");
			const resumedReader = resumed.body.getReader();
			const lines = await readLines(resumedReader, 2);
			expect(lines[0]?.event.type).toBe("session");
			expect(lines[1]?.event).toEqual({
				type: "error",
				message: "failure 3",
			});
			await resumedReader.cancel();
		} finally {
			HarnessServer.prototype.command = command;
			server.stop(true);
		}
	});

	test("sends a heartbeat while idle", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-http-test-"));
		paths.push(dir);
		const setInterval = globalThis.setInterval;
		const intervals: { delay: number | undefined; tick: () => void }[] = [];
		globalThis.setInterval = ((
			callback: TimerHandler,
			delay?: number,
			...args: never[]
		) => {
			intervals.push({
				delay,
				tick: () => (callback as () => void)(),
			});
			return setInterval(callback, delay, ...args);
		}) as unknown as typeof setInterval;
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
			const scheduledHeartbeat = intervals.at(-1);
			if (!scheduledHeartbeat) throw new Error("heartbeat was not scheduled");
			expect(scheduledHeartbeat.delay).toBeLessThan(300_000);
			scheduledHeartbeat.tick();
			const heartbeat = await reader.read();
			expect(heartbeat.done).toBe(false);
			expect(new TextDecoder().decode(heartbeat.value)).toBe("\n");
			await reader.cancel();
		} finally {
			globalThis.setInterval = setInterval;
			server.stop(true);
		}
	});

	test("keeps idle streams past Bun's default timeout", async () => {
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
			// list-skills only has to prove the stream survived the idle wait; a
			// prompt would start a real run against the configured provider.
			await fetch(`${base}/sessions/${sessionId}/commands`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ type: "list-skills" }),
			});
			expect((await reader.read()).done).toBe(false);
			await reader.cancel();
		} finally {
			server.stop(true);
		}
	}, 15_000);
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
			expect(inspection["estimatedTokens"]).toBeGreaterThan(0);
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
