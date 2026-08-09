import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../../shared/src/protocol";
import { HarnessServer } from "../src/server";
import { SessionStore } from "../src/session-store";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});
function harness() {
	const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
	paths.push(dir);
	return {
		dir,
		server: new HarnessServer(new SessionStore(join(dir, "state.sqlite")), dir),
	};
}

describe("first milestone", () => {
	test("does not run slash tool shortcuts without a configured model", async () => {
		const { server } = harness();
		const id = server.createSession();
		await server.command(id, { type: "prompt", text: "/read note.txt" });
		expect(server.store.events(id)).toContainEqual({
			type: "error",
			message:
				"no model configured; use /model <openai-codex|openai-compatible> <model> [base-url]",
		});
	});

	test("queues a follow-up after completion", async () => {
		const { server } = harness();
		const id = server.createSession();
		await server.command(id, {
			type: "follow-up",
			id: "follow-1",
			text: "afterwards",
		});
		await server.command(id, { type: "prompt", text: "first" });
		expect(
			server.store.events(id).filter((event) => event.type === "completed"),
		).toHaveLength(2);
		expect(
			server.store.events(id).every(
				(event) => event.type !== "completed" || event.durationMs !== undefined,
			),
		).toBe(true);
		expect(
			server.store.events(id).filter((event) => event.type === "command"),
		).toEqual([
			{
				type: "command",
				id: "follow-1",
				command: "follow-up",
				state: "queued",
			},
			{
				type: "command",
				id: "follow-1",
				command: "follow-up",
				state: "started",
			},
			{
				type: "command",
				id: "follow-1",
				command: "follow-up",
				state: "finished",
			},
		]);
	});

	test("persists an explicit provider/model selection for resume", async () => {
		const { dir, server } = harness();
		const id = server.createSession();
		await server.command(id, {
			type: "configure",
			provider: "openai-compatible",
			model: "test-model",
			baseUrl: "http://127.0.0.1:1/v1",
		});
		expect(
			new HarnessServer(
				new SessionStore(join(dir, "state.sqlite")),
				dir,
			).store.modelConfig(id),
		).toEqual({
			provider: "openai-compatible",
			model: "test-model",
			baseUrl: "http://127.0.0.1:1/v1",
		});
	});

	test("streams an OpenAI-compatible model through the Pi agent loop and core tools", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				expect(request.headers.get("authorization")).toBe("Bearer test");
				calls++;
				const body =
					calls === 1
						? [
								'data: {"id":"one","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"note.txt\\"}"}}]},"finish_reason":null}]}\n\n',
								'data: {"id":"one","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
								"data: [DONE]\n\n",
							]
						: [
								'data: {"id":"two","choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\n',
								'data: {"id":"two","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":8,"completion_tokens":1,"total_tokens":9}}\n\n',
								"data: [DONE]\n\n",
							];
				return new Response(
					new ReadableStream({
						start(controller) {
							for (const chunk of body)
								controller.enqueue(new TextEncoder().encode(chunk));
							controller.close();
						},
					}),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const { dir, server } = harness();
			writeFileSync(join(dir, "note.txt"), "hello");
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			await server.command(id, { type: "prompt", text: "read note.txt" });
			const events = server.store.events(id);
			expect(calls).toBe(2);
			expect(
				events.some(
					(event) => event.type === "assistant-delta" && event.text === "done",
				),
			).toBe(true);
			expect(
				events.some(
					(event) => event.type === "tool-call" && event.name === "read",
				),
			).toBe(true);
			expect(
				events.some(
					(event) => event.type === "tool-result" && event.output === "hello",
				),
			).toBe(true);
			expect(
				events.some(
					(event) => event.type === "usage" && event.totalTokens === 9,
				),
			).toBe(true);
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("drains steering between turns before follow-ups", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		let calls = 0;
		let firstRequestStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			firstRequestStarted = resolve;
		});
		const provider = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				const response = (id: string, text: string) =>
					`data: {"id":"${id}","choices":[{"delta":{"content":"${text}"},"finish_reason":null}]}\n\n` +
					`data: {"id":"${id}","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n` +
					"data: [DONE]\n\n";
				if (calls === 1)
					return new Response(
						new ReadableStream({
							start(controller) {
								firstRequestStarted();
								setTimeout(() => {
									controller.enqueue(
										new TextEncoder().encode(response("first", "first")),
									);
									controller.close();
								}, 30);
							},
						}),
						{ headers: { "content-type": "text/event-stream" } },
					);
				return new Response(response(`turn-${calls}`, `turn ${calls}`), {
					headers: { "content-type": "text/event-stream" },
				});
			},
		});
		try {
			const { server } = harness();
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			const running = server.command(id, { type: "prompt", text: "first" });
			await started;
			await server.command(id, {
				type: "follow-up",
				id: "follow-1",
				text: "afterwards",
			});
			await server.command(id, {
				type: "steer",
				id: "steer-1",
				text: "new direction",
			});
			await running;
			const events = server.store.events(id);
			expect(calls).toBe(3);
			expect(events.filter((event) => event.type === "completed")).toHaveLength(
				1,
			);
			expect(
				events
					.filter(
						(event): event is Extract<ServerEvent, { type: "command" }> =>
							event.type === "command" && event.state === "started",
					)
					.map((event) => event.id),
			).toEqual(["steer-1", "follow-1"]);
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("aborts an in-flight OpenAI-compatible Pi request", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		let started!: () => void;
		const requestStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const provider = Bun.serve({
			port: 0,
			fetch: (request) =>
				new Promise<Response>((resolve) => {
					started();
					request.signal.addEventListener(
						"abort",
						() => resolve(new Response("cancelled", { status: 499 })),
						{ once: true },
					);
				}),
		});
		try {
			const { server } = harness();
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			const running = server.command(id, { type: "prompt", text: "wait" });
			await requestStarted;
			await server.command(id, { type: "abort" });
			await Promise.race([
				running,
				new Promise((_, reject) =>
					setTimeout(
						() => reject(new Error("model cancellation timed out")),
						1_000,
					),
				),
			]);
			expect(
				server.store.events(id).filter((event) => event.type === "aborted"),
			).toHaveLength(1);
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});
});
