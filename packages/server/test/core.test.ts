import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessServer } from "../src/server";
import { SessionStore } from "../src/session-store";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});
function harness(contextBudget?: number) {
	const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
	paths.push(dir);
	return {
		dir,
		server: new HarnessServer(new SessionStore(join(dir, "state.sqlite")), dir, {
			contextBudget,
		}),
	};
}

describe("first milestone", () => {
	test("executes and persists a core read tool", async () => {
		const { dir, server } = harness();
		writeFileSync(join(dir, "note.txt"), "hello");
		const id = server.createSession();
		await server.command(id, { type: "prompt", text: "/read note.txt" });
		const events = server.store.events(id);
		expect(
			events.some(
				(event) => event.type === "tool-result" && event.output === "hello",
			),
		).toBe(true);
		expect(
			new HarnessServer(
				new SessionStore(join(dir, "state.sqlite")),
				dir,
			).store.events(id),
		).toEqual(events);
	});

	test("rejects tool paths outside the workspace", async () => {
		const { server } = harness();
		const id = server.createSession();
		await server.command(id, { type: "prompt", text: "/read ../secret" });
		expect(
			server.store
				.events(id)
				.some(
					(event) =>
						event.type === "tool-result" &&
						event.isError &&
						event.output.includes("escapes workspace"),
				),
		).toBe(true);
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

	test("restarts with steering after aborting foreground work", async () => {
		const { server } = harness();
		const id = server.createSession();
		const running = server.command(id, {
			type: "prompt",
			text: "/bash\nsleep 1",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		await server.command(id, {
			type: "steer",
			id: "steer-1",
			text: "superseded direction",
		});
		await server.command(id, {
			type: "steer",
			id: "steer-2",
			text: "new direction",
		});
		await running;
		expect(
			server.store.events(id).filter((event) => event.type === "aborted"),
		).toHaveLength(1);
		expect(
			server.store.events(id).filter((event) => event.type === "completed"),
		).toHaveLength(1);
		expect(
			server.store.events(id).filter((event) => event.type === "command"),
		).toEqual([
			{ type: "command", id: "steer-1", command: "steer", state: "replaced" },
			{ type: "command", id: "steer-2", command: "steer", state: "started" },
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
		process.env.HARNESS_OPENAI_API_KEY = "test";
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
			delete process.env.HARNESS_OPENAI_API_KEY;
		}
	});

	test("aborts an in-flight OpenAI-compatible Pi request", async () => {
		process.env.HARNESS_OPENAI_API_KEY = "test";
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
			delete process.env.HARNESS_OPENAI_API_KEY;
		}
	});

	test("rebuilds managed context after restart without losing raw tool history", async () => {
		process.env.HARNESS_OPENAI_API_KEY = "test";
		const bodies: { messages: { role: string; tool_calls?: { id: string }[] }[] }[] =
			[];
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				bodies.push(
					(await request.json()) as {
						messages: { role: string; tool_calls?: { id: string }[] }[];
					},
				);
				calls++;
				const body =
					calls === 1
						? [
								'data: {"id":"one","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-read","type":"function","function":{"name":"read","arguments":"{\\"path\\":\\"note.txt\\"}"}}]},"finish_reason":null}]}\n\n',
								'data: {"id":"one","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}\n\n',
								"data: [DONE]\n\n",
							]
						: [
								'data: {"id":"done","choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\n',
								'data: {"id":"done","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n',
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
			const output = "x".repeat(10_000);
			const { dir, server } = harness(1_500);
			writeFileSync(join(dir, "note.txt"), output);
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			await server.command(id, { type: "prompt", text: "read note.txt" });
			const rawTool = server.store
				.contextItems(id)
				.find((item) => item.kind === "tool-result");
			expect(rawTool?.payload).toMatchObject({ role: "toolResult" });
			expect(JSON.stringify(rawTool?.payload)).toContain("observation://obs-");
			expect(JSON.stringify(rawTool?.payload).length).toBeLessThan(output.length);
			expect(
				server.store.contextItems(id).some(
					(item) => item.kind === "observation" && item.payload === output,
				),
			).toBe(true);

			const restarted = new HarnessServer(
				new SessionStore(join(dir, "state.sqlite")),
				dir,
				{ contextBudget: 1_500 },
			);
			await restarted.command(id, {
				type: "prompt",
				text: "continue ".repeat(250),
			});

			expect(calls).toBe(3);
			expect(JSON.stringify(bodies[2])).not.toContain(output);
			expect(JSON.stringify(bodies[2])).toContain("Earlier read output was compacted");
			expect(JSON.stringify(bodies[2])).toContain("observation://obs-");
			for (const body of bodies)
				for (const call of body.messages.flatMap(
					(message) => message.tool_calls ?? [],
				))
					expect(
						body.messages.some(
							(message) =>
								message.role === "tool" &&
								(message as { tool_call_id?: string }).tool_call_id === call.id,
						),
					).toBe(true);
		} finally {
			provider.stop(true);
			delete process.env.HARNESS_OPENAI_API_KEY;
		}
	});

	test("pins context and recalls an exact archived observation slice", async () => {
		process.env.HARNESS_OPENAI_API_KEY = "test";
		const bodies: { messages: { role: string; content?: string; tool_call_id?: string }[] }[] =
			[];
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body = (await request.json()) as {
					messages: { role: string; content?: string; tool_call_id?: string }[];
				};
				bodies.push(body);
				calls++;
				const chunks =
					calls === 1
						? toolCallChunks("call-pin", "pin_context", {
								kind: "constraint",
								text: "keep this needle",
							})
						: calls === 2
							? toolCallChunks("call-read", "read", { path: "note.txt" })
							: calls === 3
								? toolCallChunks("call-recall", "recall_observation", {
										reference: `${observationReference(body, "call-read")}?offset=10&limit=5`,
									})
								: doneChunks();
				return sseResponse(chunks);
			},
		});
		try {
			const { dir, server } = harness();
			writeFileSync(join(dir, "note.txt"), `0123456789ABCDE${"x".repeat(20_000)}`);
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			await server.command(id, { type: "prompt", text: "pin, read, then recall" });

			expect(calls).toBe(4);
			expect(JSON.stringify(bodies[1])).toContain("keep this needle");
			expect(
			bodies[2].messages.find(
				(message) => message.tool_call_id === "call-read",
			)?.content?.length,
		).toBeLessThanOrEqual(16_000);
			expect(
			bodies[3].messages.find(
				(message) => message.tool_call_id === "call-recall",
			)?.content,
		).toBe("ABCDE");
			expect(
			server.store.contextItems(id).some(
				(item) =>
					item.kind === "pinned-note" &&
					JSON.stringify(item.payload).includes("keep this needle"),
			),
		).toBe(true);
		} finally {
			provider.stop(true);
			delete process.env.HARNESS_OPENAI_API_KEY;
		}
	});

	test("uses episode boundaries and preserves exploration conclusions after eviction", async () => {
		process.env.HARNESS_OPENAI_API_KEY = "test";
		const bodies: {
			messages: { role: string; content?: string; tool_call_id?: string }[];
		}[] = [];
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body = (await request.json()) as (typeof bodies)[number];
				bodies.push(body);
				calls++;
				const chunks =
					calls === 1
						? toolCallChunks("episode-explore", "episode", {
								action: "start",
								name: "inspect-auth",
								kind: "exploration",
							})
						: calls === 2
							? toolCallChunks("read-auth", "read", { path: "note.txt" })
							: calls === 3
								? toolCallChunks("episode-end-explore", "episode", {
										action: "end",
										conclusion: "JWT validation happens before routing.",
									})
								: calls === 4
									? toolCallChunks("episode-action", "episode", {
											action: "start",
											name: "apply-auth-fix",
											kind: "action",
											dependencies: [
												episodeId(body, "episode-explore"),
											],
										})
									: calls === 5
										? toolCallChunks("write-fix", "write", {
												path: "changed.txt",
												content: "done",
											})
										: calls === 6
											? toolCallChunks("episode-end-action", "episode", {
													action: "end",
												})
											: doneChunks();
				return sseResponse(chunks);
			},
		});
		try {
			const { dir, server } = harness(1_600);
			writeFileSync(join(dir, "note.txt"), "auth uses JWT");
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			await server.command(id, { type: "prompt", text: "inspect then fix auth" });
			await server.command(id, {
				type: "prompt",
				text: "follow-up ".repeat(200),
			});

			expect(calls).toBe(8);
			expect(JSON.stringify(bodies.at(-1))).toContain(
				"JWT validation happens before routing.",
			);
			expect(server.contextStatus(id).episodes).toMatchObject([
				{ name: "inspect-auth", state: "archived" },
				{ name: "apply-auth-fix", state: "archived" },
			]);
			expect(JSON.stringify(server.store.contextItems(id))).toContain(
				"auth uses JWT",
			);
		} finally {
			provider.stop(true);
			delete process.env.HARNESS_OPENAI_API_KEY;
		}
	});

	test("rejects an over-budget prompt before calling the provider", async () => {
		process.env.HARNESS_OPENAI_API_KEY = "test";
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				return new Response("unexpected provider request", { status: 500 });
			},
		});
		try {
			const { server } = harness(500);
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			await server.command(id, {
				type: "prompt",
				text: "too much context ".repeat(500),
			});
			expect(calls).toBe(0);
			expect(
				server.store.events(id).some(
					(event) =>
						event.type === "error" &&
						event.message.includes("Context budget cannot be satisfied"),
				),
			).toBe(true);
		} finally {
			provider.stop(true);
			delete process.env.HARNESS_OPENAI_API_KEY;
		}
	});

	test("compacts assistant turns without removing user-authored messages", async () => {
		process.env.HARNESS_OPENAI_API_KEY = "test";
		const bodies: unknown[] = [];
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				bodies.push(await request.json());
				calls++;
				return sseResponse(textChunks(`reply-${calls}-${"x".repeat(2_000)}`));
			},
		});
		try {
			const { server } = harness(1_200);
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			for (let index = 0; index < 5; index++)
				await server.command(id, {
					type: "prompt",
					text: index === 0 ? "durable objective" : `follow-up ${index}`,
				});

			expect(calls).toBe(5);
			expect(JSON.stringify(bodies.at(-1))).toContain("durable objective");
			expect(JSON.stringify(bodies.at(-1))).toContain("follow-up 4");
			expect(JSON.stringify(bodies.at(-1))).not.toContain("reply-1-");
			expect(JSON.stringify(server.store.contextItems(id))).toContain("reply-1-");
			expect(
				server.store
					.contextItems(id)
					.filter((item) => item.kind === "user" && item.lifecycle === "pinned"),
			).toHaveLength(5);
		} finally {
			provider.stop(true);
			delete process.env.HARNESS_OPENAI_API_KEY;
		}
	});
});

function toolCallChunks(
	id: string,
	name: string,
	arguments_: Record<string, unknown>,
): string[] {
	return [
		`data: ${JSON.stringify({ id, choices: [{ delta: { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(arguments_) } }] }, finish_reason: null }] })}\n\n`,
		`data: ${JSON.stringify({ id, choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })}\n\n`,
		"data: [DONE]\n\n",
	];
}

function doneChunks(): string[] {
	return [
		'data: {"id":"done","choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\n',
		'data: {"id":"done","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n',
		"data: [DONE]\n\n",
	];
}

function textChunks(text: string): string[] {
	return [
		`data: ${JSON.stringify({ id: "text", choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n`,
		'data: {"id":"text","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n',
		"data: [DONE]\n\n",
	];
}

function sseResponse(chunks: string[]): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				for (const chunk of chunks)
					controller.enqueue(new TextEncoder().encode(chunk));
				controller.close();
			},
		}),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function observationReference(
	body: { messages: { content?: string; tool_call_id?: string }[] },
	toolCallId: string,
): string {
	const reference = body.messages
		.find((message) => message.tool_call_id === toolCallId)
		?.content?.match(/observation:\/\/obs-[\w-]+/)?.[0];
	if (!reference) throw new Error("provider did not receive an observation URI");
	return reference;
}

function episodeId(
	body: { messages: { content?: string; tool_call_id?: string }[] },
	toolCallId: string,
): string {
	const id = body.messages
		.find((message) => message.tool_call_id === toolCallId)
		?.content?.match(/\(([0-9a-f-]{36})\)/)?.[1];
	if (!id) throw new Error("provider did not receive an episode ID");
	return id;
}
