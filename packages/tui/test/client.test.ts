import { expect, test } from "bun:test";
import { HarnessClient } from "../src/client";

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
