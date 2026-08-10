import { expect, test } from "bun:test";
import type { ServerEvent } from "../../shared/src/protocol";
import { HarnessClient } from "../src/client";

test("resumes the event stream after the last applied cursor", async () => {
	const requested: (string | null)[] = [];
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			requested.push(new URL(request.url).searchParams.get("from"));
			const seq = requested.length === 1 ? 7 : 9;
			const text = requested.length === 1 ? "a" : "b";
			return new Response(
				// A heartbeat blank line rides along to prove it is skipped.
				`\n${JSON.stringify({
					seq,
					event: { type: "assistant-delta", text },
				})}\n`,
				{ headers: { "content-type": "application/x-ndjson" } },
			);
		},
	});
	try {
		const client = new HarnessClient(server.url.toString().replace(/\/$/, ""));
		const controller = new AbortController();
		const events: ServerEvent[] = [];
		let cursor = 0;
		const options = {
			signal: controller.signal,
			onEvent: (event: ServerEvent) => void events.push(event),
			onCursor: (seq: number) => {
				cursor = seq;
			},
		};
		await client.stream("session", options);
		expect(cursor).toBe(7);
		await client.stream("session", { ...options, from: cursor });
		expect(cursor).toBe(9);
		expect(requested).toEqual([null, "7"]);
		expect(events).toEqual([
			{ type: "assistant-delta", text: "a" },
			{ type: "assistant-delta", text: "b" },
		]);
	} finally {
		server.stop(true);
	}
});

test("surfaces a rejected server command", async () => {
	const server = Bun.serve({
		port: 0,
		fetch: () => Response.json({ error: "cannot change model while running" }, { status: 409 }),
	});
	try {
		await expect(
			new HarnessClient(server.url.toString().replace(/\/$/, "")).send("session", {
				type: "configure",
				provider: "fake",
				model: "model-1",
			}),
		).rejects.toThrow("cannot change model while running");
	} finally {
		server.stop(true);
	}
});

test("creates sessions in the client working directory", async () => {
	let cwd: unknown;
	const server = Bun.serve({
		port: 0,
		fetch: async (request) => {
			cwd = ((await request.json()) as { cwd: unknown }).cwd;
			return Response.json({ sessionId: "session" });
		},
	});
	try {
		expect(
			await new HarnessClient(server.url.toString().replace(/\/$/, "")).createSession(),
		).toBe("session");
		expect(cwd).toBe(process.cwd());
	} finally {
		server.stop(true);
	}
});
