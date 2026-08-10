import { afterEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthType, ServerEvent } from "../../shared/src/protocol";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { JsonCredentialStore } from "../src/provider";
import { HarnessServer } from "../src/server";
import { SessionStore } from "../src/session-store";
import { SettingsStore } from "../src/settings-store";

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
		server: new HarnessServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			undefined,
			settings(dir),
		),
	};
}

function settings(dir: string) {
	return new SettingsStore(
		join(dir, "config/settings.json"),
		join(dir, ".harness/settings.json"),
	);
}

function fakeModels() {
	const fakeProvider = {
		id: "fake",
		name: "Fake",
		auth: { apiKey: { name: "Fake API key", login: async () => ({}) } },
	};
	const fakeModel = {
		id: "model-1",
		name: "Model 1",
		provider: "fake",
	};
	return {
		getProviders: () => [fakeProvider],
		getProvider: (provider: string) =>
			provider === "fake" ? fakeProvider : undefined,
		getModels: (provider?: string) =>
			provider && provider !== "fake" ? [] : [fakeModel],
		getModel: (provider: string, model: string) =>
			provider === "fake" && model === "model-1" ? fakeModel : undefined,
		checkAuth: async (provider: string) =>
			provider === "fake" ? { type: "api_key" as const, source: "stored" } : undefined,
		getAvailable: async () => [fakeModel],
		login: async (
			_provider: string,
			_type: AuthType,
			interaction: AuthInteraction,
		) => ({
			type: "api_key" as const,
			key: await interaction.prompt({ type: "secret", message: "API key" }),
		}),
		refresh: async () => ({ aborted: false, errors: new Map() }),
	};
}

async function until(assertion: () => void): Promise<void> {
	for (let attempts = 0; attempts < 20; attempts++) {
		try {
			assertion();
			return;
		} catch {
			await Bun.sleep(1);
		}
	}
	assertion();
}

describe("first milestone", () => {
	test("keeps each session's workspace", () => {
		const first = mkdtempSync(join(tmpdir(), "harness-workspace-test-"));
		const second = mkdtempSync(join(tmpdir(), "harness-workspace-test-"));
		paths.push(first, second);
		const server = new HarnessServer(
			new SessionStore(join(first, "state.sqlite")),
			first,
			fakeModels(),
			settings(first),
		);

		const firstId = server.createSession(first);
		const secondId = server.createSession(second);

		expect(server.workspace(firstId)).toBe(first);
		expect(server.workspace(secondId)).toBe(second);
		const restarted = new HarnessServer(
			new SessionStore(join(first, "state.sqlite")),
			first,
			fakeModels(),
			settings(first),
		);
		expect(restarted.workspace(secondId)).toBe(second);
	});

	test("uses project settings from each session workspace", () => {
		const first = mkdtempSync(join(tmpdir(), "harness-workspace-test-"));
		const second = mkdtempSync(join(tmpdir(), "harness-workspace-test-"));
		paths.push(first, second);
		for (const [dir, model] of [
			[first, "first-model"],
			[second, "second-model"],
		] as const) {
			mkdirSync(join(dir, ".harness"));
			writeFileSync(
				join(dir, ".harness/settings.json"),
				JSON.stringify({ model: { provider: "fake", model } }),
			);
		}
		const server = new HarnessServer(
			new SessionStore(join(first, "state.sqlite")),
			first,
			fakeModels(),
			settings(first),
		);
		const events: ServerEvent[] = [];
		const firstId = server.createSession(first);
		const secondId = server.createSession(second);
		server.subscribe(firstId, (event) => events.push(event));
		server.subscribe(secondId, (event) => events.push(event));

		expect(events).toContainEqual({
			type: "model-config",
			config: { provider: "fake", model: "first-model" },
		});
		expect(events).toContainEqual({
			type: "model-config",
			config: { provider: "fake", model: "second-model" },
		});
	});

	test("does not persist a credential after its queued write is cancelled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
		paths.push(dir);
		const credentials = new JsonCredentialStore(join(dir, "auth.json"));
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = credentials.modify("first", async () => {
			await blocked;
			return { type: "api_key", key: "first" };
		});
		const controller = new AbortController();
		const cancelled = credentials.modify(
			"cancelled",
			async () => ({ type: "api_key", key: "must-not-land" }),
			{ signal: controller.signal },
		);
		controller.abort();
		release();
		await first;
		await expect(cancelled).rejects.toThrow();
		expect(await credentials.read("cancelled")).toBeUndefined();
		await credentials.modify("after", async () => ({
			type: "api_key",
			key: "still-works",
		}));
		expect(await credentials.read("after")).toEqual({
			type: "api_key",
			key: "still-works",
		});
		expect(await credentials.modify("after", async () => undefined)).toEqual({
			type: "api_key",
			key: "still-works",
		});
	});

	test("lists transient configured provider and model catalogs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
		paths.push(dir);
		const server = new HarnessServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			fakeModels(),
			settings(dir),
		);
		const id = server.createSession();
		const events: ServerEvent[] = [];
		server.subscribe(id, (event) => events.push(event));

		await server.command(id, { type: "list-providers" });
		await server.command(id, { type: "list-models" });

		expect(events).toContainEqual({
			type: "providers",
			providers: [
				{
					id: "fake",
					name: "Fake",
					authTypes: ["api_key"],
					configured: true,
				},
			],
		});
		expect(events).toContainEqual({
			type: "models",
			models: [
				{
					provider: "fake",
					providerName: "Fake",
					id: "model-1",
					name: "Model 1",
				},
			],
		});
		expect(server.store.events(id)).toEqual([]);
	});

	test("lists skills for composer suggestions", async () => {
		const { dir, server } = harness();
		mkdirSync(join(dir, ".harness/skills/review"), { recursive: true });
		writeFileSync(
			join(dir, ".harness/skills/review/SKILL.md"),
			"---\nname: review\ndescription: Review changes\n---\nReview carefully.",
		);
		const id = server.createSession();
		const events: ServerEvent[] = [];
		server.subscribe(id, (event) => events.push(event));

		await server.command(id, { type: "list-skills" });

		expect(events).toContainEqual({
			type: "skills",
			skills: expect.arrayContaining([
				{ name: "review", description: "Review changes" },
			]),
		});
	});

	test("persists a selected non-OpenAI model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
		paths.push(dir);
		const server = new HarnessServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			fakeModels(),
			settings(dir),
		);
		const id = server.createSession();
		const events: ServerEvent[] = [];
		server.subscribe(id, (event) => events.push(event));

		await server.command(id, {
			type: "configure",
			provider: "fake",
			model: "model-1",
		});

		expect(server.store.modelConfig(id)).toEqual({
			provider: "fake",
			model: "model-1",
		});
		expect(events).toContainEqual({
			type: "model-config",
			config: { provider: "fake", model: "model-1" },
		});
		expect(
			JSON.parse(
				readFileSync(join(dir, "config/settings.json"), "utf8"),
			),
		).toEqual({ model: { provider: "fake", model: "model-1" } });

		const restarted = new HarnessServer(
			new SessionStore(join(dir, "fresh.sqlite")),
			dir,
			fakeModels(),
			settings(dir),
		);
		const restartedEvents: ServerEvent[] = [];
		restarted.subscribe(restarted.createSession(), (event) =>
			restartedEvents.push(event),
		);
		expect(restartedEvents).toContainEqual({
			type: "model-config",
			config: { provider: "fake", model: "model-1" },
		});

		mkdirSync(join(dir, ".harness"));
		writeFileSync(
			join(dir, ".harness/settings.json"),
			'{"model":{"provider":"project","model":"model-2"}}',
		);
		const project = new HarnessServer(
			new SessionStore(join(dir, "project.sqlite")),
			dir,
			fakeModels(),
			settings(dir),
		);
		const projectEvents: ServerEvent[] = [];
		project.subscribe(project.createSession(), (event) => projectEvents.push(event));
		expect(projectEvents).toContainEqual({
			type: "model-config",
			config: { provider: "project", model: "model-2" },
		});
		const projectId = project.createSession();
		await project.command(projectId, {
			type: "configure",
			provider: "fake",
			model: "model-1",
		});
		expect(
			JSON.parse(readFileSync(join(dir, ".harness/settings.json"), "utf8")),
		).toEqual({ model: { provider: "fake", model: "model-1" } });
	});

	test("rejects an unknown model before persisting it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
		paths.push(dir);
		const server = new HarnessServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			fakeModels(),
			settings(dir),
		);
		const id = server.createSession();
		await expect(
			server.command(id, {
				type: "configure",
				provider: "fake",
				model: "missing",
			}),
		).rejects.toThrow("unknown model fake/missing");
		expect(server.store.modelConfig(id)).toBeUndefined();
	});

	test("relays a login prompt without persisting its answer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
		paths.push(dir);
		const server = new HarnessServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			fakeModels(),
			settings(dir),
		);
		const id = server.createSession();
		const events: ServerEvent[] = [];
		server.subscribe(id, (event) => events.push(event));

		await server.command(id, {
			type: "login",
			provider: "fake",
			authType: "api_key",
		});
		const prompt = events.find((event) => event.type === "auth-prompt");
		expect(prompt).toBeDefined();
		if (!prompt || prompt.type !== "auth-prompt") throw new Error("missing prompt");
		await server.command(id, {
			type: "auth-answer",
			promptId: prompt.prompt.id,
			value: "never persist this",
		});
		await until(() =>
			expect(events).toContainEqual({ type: "auth-completed", provider: "fake" }),
		);
		expect(server.store.events(id)).toEqual([]);
	});

	test("closes a failed login transiently", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
		paths.push(dir);
		const models = fakeModels();
		models.login = async () => {
			throw new Error("login failed");
		};
		const server = new HarnessServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			models,
			settings(dir),
		);
		const id = server.createSession();
		const events: ServerEvent[] = [];
		server.subscribe(id, (event) => events.push(event));

		await server.command(id, {
			type: "login",
			provider: "fake",
			authType: "api_key",
		});
		await until(() =>
			expect(events).toContainEqual({
				type: "auth-cancelled",
				provider: "fake",
			}),
		);
		expect(events).toContainEqual({ type: "error", message: "login failed" });
		expect(server.store.events(id)).toEqual([]);
	});

	test("cancels one login and rejects a concurrent login", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
		paths.push(dir);
		const server = new HarnessServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			fakeModels(),
			settings(dir),
		);
		const id = server.createSession();
		const events: ServerEvent[] = [];
		server.subscribe(id, (event) => events.push(event));

		await server.command(id, {
			type: "login",
			provider: "fake",
			authType: "api_key",
		});
		await server.command(id, {
			type: "login",
			provider: "fake",
			authType: "api_key",
		});
		expect(events).toContainEqual({
			type: "error",
			message: "a login is already in progress",
		});
		await server.command(id, { type: "auth-cancel" });
		await until(() =>
			expect(events).toContainEqual({ type: "auth-cancelled", provider: "fake" }),
		);
		expect(server.store.events(id)).toEqual([]);
	});

	test("does not run slash tool shortcuts without a configured model", async () => {
		const { server } = harness();
		const id = server.createSession();
		await server.command(id, { type: "prompt", text: "/read note.txt" });
		expect(server.store.events(id)).toContainEqual({
			type: "error",
			message:
				"no model configured; use /model",
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
				undefined,
				settings(dir),
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
		const requests: string[] = [];
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				expect(request.headers.get("authorization")).toBe("Bearer test");
				requests.push(await request.text());
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
			mkdirSync(join(dir, ".harness/skills/review"), { recursive: true });
			writeFileSync(
				join(dir, ".harness/skills/review/SKILL.md"),
				"---\nname: review\ndescription: review instructions\n---\nReview carefully.",
			);
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			await server.command(id, {
				type: "prompt",
				text: "Please /review read note.txt",
			});
			const events = server.store.events(id);
			expect(calls).toBe(2);
			expect(requests[0]).toContain("Review carefully.");
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
