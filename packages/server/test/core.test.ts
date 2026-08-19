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
import { createHarnezModels, JsonCredentialStore } from "../src/provider";
import { HarnezServer } from "../src/server";
import { managedMessages } from "../src/agent/events";
import { ContextManager } from "../src/context/manager";
import { SessionStore } from "../src/sessions/store";
import { SettingsStore } from "../src/settings-store";
import { BashTool } from "../src/tools/bash";

const paths: string[] = [];
const originalConfigHome = process.env["XDG_CONFIG_HOME"];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
	if (originalConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
	else process.env["XDG_CONFIG_HOME"] = originalConfigHome;
});
function harnez(contextBudget?: number) {
	const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
	paths.push(dir);
	return {
		dir,
		server: new HarnezServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			undefined,
			settings(dir),
			contextBudget === undefined ? {} : { contextBudget },
		),
	};
}

function settings(dir: string) {
	return new SettingsStore(
		join(dir, "config/settings.json"),
		join(dir, ".harnez/settings.json"),
	);
}

function fakeModels(
	modelOverrides: Record<string, unknown> = {},
	ids: string[] = ["model-1"],
) {
	const fakeProvider = {
		id: "fake",
		name: "Fake",
		auth: { apiKey: { name: "Fake API key", login: async () => ({}) } },
	};
	const fakeModelList = ids.map((id, index) => ({
		id,
		name: `Model ${index + 1}`,
		provider: "fake",
		...modelOverrides,
	}));
	return {
		getProviders: () => [fakeProvider],
		getProvider: (provider: string) =>
			provider === "fake" ? fakeProvider : undefined,
		getModel: (provider: string, model: string) =>
			provider === "fake"
				? fakeModelList.find((candidate) => candidate.id === model)
				: undefined,
		checkAuth: async (provider: string) =>
			provider === "fake" ? { type: "api_key" as const, source: "stored" } : undefined,
		getAvailable: async () => fakeModelList,
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
	test("does not send tool results without their assistant tool call", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-core-orphan-tool-"));
		paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite"));
		const sessionId = store.create(dir);
		const context = new ContextManager(store);
		context.record({
			sessionId,
			kind: "assistant",
			payload: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "call-episode",
						name: "episode",
						arguments: {},
					},
				],
			},
			tokenCost: 10,
			lifecycle: "archived",
			projection: "omitted",
			reason: "compacted",
			groupId: "group-episode",
		});
		context.record({
			sessionId,
			kind: "tool-result",
			payload: {
				role: "toolResult",
				toolCallId: "call-episode",
				toolName: "episode",
				content: [
					{
						type: "text",
						text: "Action episodes require an exploration dependency",
					},
				],
				isError: true,
			},
			tokenCost: 10,
			lifecycle: "retained",
			projection: "full",
			reason: "tool result",
			groupId: "group-episode",
		});

		const messages = managedMessages({
			sessionId,
			store,
			context,
			model: {} as never,
			contextOptions: () => ({
				budget: 20_000,
				target: 16_000,
				overheadTokens: 0,
			}),
		});

		expect(messages).not.toContainEqual(
			expect.objectContaining({
				role: "toolResult",
				toolCallId: "call-episode",
			}),
		);
		store.db.close();
	});

	test("proactive condensation reaches the next provider assembly and preserves recall", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-core-condensation-"));
		paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite"));
		const sessionId = store.create(dir);
		const context = new ContextManager(store);
		context.record({ sessionId, kind: "system", payload: "stable semantics", tokenCost: 2, lifecycle: "pinned", projection: "full", reason: "system" });
		context.record({ sessionId, kind: "user", payload: { role: "user", content: "objective" }, tokenCost: 2, lifecycle: "pinned", projection: "full", reason: "user" });
		for (let index = 0; index < 6; index++) {
			const groupId = `group-${index}`;
			context.record({
				sessionId,
				kind: "assistant",
				payload: {
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: `call-${index}`,
							name: "read",
							arguments: {},
						},
					],
				},
				tokenCost: 10,
				lifecycle: "retained",
				projection: "full",
				reason: "tool call",
				groupId,
			});
			context.record({
				sessionId,
				kind: "tool-result",
				payload: {
					role: "toolResult",
					toolCallId: `call-${index}`,
					toolName: "read",
					content: [{ type: "text", text: `recent-${index}` }],
					isError: false,
				},
				tokenCost: 1_000,
				lifecycle: "retained",
				projection: "full",
				reason: "done",
				groupId,
			});
		}
		context.recordObservation(sessionId, "exact archived output", { observationId: "obs-core" });
		const condensed = context.condense(sessionId, { milestone: "subtask done", completedWork: ["implemented"], strategies: [], environmentChanges: [], constraints: [], openQuestions: [], references: ["observation://obs-core"] }, { budget: 20_000, target: 16_000 });
		expect(condensed.noOp).toBe(false);
		const messages = managedMessages({ sessionId, store, context, model: {} as never, contextOptions: () => ({ budget: 20_000, target: 16_000, overheadTokens: 0 }) });
		const serialized = JSON.stringify(messages);
		expect(serialized).toContain("<harnez-long-term-memory>");
		expect(serialized).toContain("recent-5");
		expect(context.recall(sessionId, "observation://obs-core").text).toBe("exact archived output");
		const automatic = context.assemble(sessionId, { budget: 1_000, target: 800, overheadTokens: 0 });
		expect(automatic.tokensAfter).toBeLessThanOrEqual(automatic.tokensBefore);
	});
	test("does not list a session until a user submits a message", async () => {
		const { server } = harnez();
		const id = server.createSession();

		expect(server.store.list()).toEqual([]);
		await server.command(id, {
			type: "set-session-title",
			title: "Setup only",
		});
		expect(server.store.list()).toEqual([]);

		await server.command(id, { type: "steer", text: "First message" });
		expect(server.store.list()).toContainEqual({
			id,
			createdAt: expect.any(String),
			workspace: expect.any(String),
			title: "Setup only",
		});
	});

	test("persists user messages for session replay", async () => {
		const { server } = harnez();
		const id = server.createSession();

		await server.command(id, {
			type: "steer",
			id: "user-1",
			text: "Remember this message",
		});

		expect(server.store.events(id)).toContainEqual({
			type: "user",
			id: "user-1",
			text: "Remember this message",
		});
	});

	test("rejects images on non-vision models without user or context records", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-image-model-test-"));
		paths.push(dir);
		const server = new HarnezServer(new SessionStore(join(dir, "state.sqlite")), dir, fakeModels({ input: ["text"] }), settings(dir));
		const id = server.createSession();
		await server.command(id, { type: "configure", provider: "fake", model: "model-1" });
		await expect(server.command(id, { type: "prompt", text: "image", images: [{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/png", data: "iVBORw0KGgo=" }] })).rejects.toThrow("does not support images");
		expect(server.store.events(id).some((event) => event.type === "user")).toBe(false);
		expect(server.store.contextItems(id)).toEqual([]);
	});

	test("records vision images after text in provider order", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-image-model-test-"));
		paths.push(dir);
		const server = new HarnezServer(new SessionStore(join(dir, "state.sqlite")), dir, fakeModels({ input: ["text", "image"], contextWindow: 100_000, maxTokens: 1_000 }), settings(dir));
		const images = [
			{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/png" as const, data: "iVBORw0KGgo=" },
			{ id: "00000000-0000-4000-8000-000000000002", mimeType: "image/png" as const, data: "iVBORw0KGgo=" },
		];
		let received: { text?: string; images?: typeof images } | undefined;
		(server as unknown as { runtime: { run: (input: { text: string; images?: typeof images }) => Promise<{ modelDurationMs: number; toolDurationMs: number }> } }).runtime.run = async (input) => { received = input; return { modelDurationMs: 0, toolDurationMs: 0 }; };
		const id = server.createSession();
		await server.command(id, { type: "configure", provider: "fake", model: "model-1" });
		await server.command(id, { type: "prompt", text: "image", images });
		expect(received?.text).toBe("image");
		expect(received?.images).toEqual(images);
	});

	test("keeps each session's workspace", () => {
		const first = mkdtempSync(join(tmpdir(), "harnez-workspace-test-"));
		const second = mkdtempSync(join(tmpdir(), "harnez-workspace-test-"));
		paths.push(first, second);
		const server = new HarnezServer(
			new SessionStore(join(first, "state.sqlite")),
			first,
			fakeModels(),
			settings(first),
		);

		const firstId = server.createSession(first);
		const secondId = server.createSession(second);

		expect(server.workspace(firstId)).toBe(first);
		expect(server.workspace(secondId)).toBe(second);
		const restarted = new HarnezServer(
			new SessionStore(join(first, "state.sqlite")),
			first,
			fakeModels(),
			settings(first),
		);
		expect(restarted.workspace(secondId)).toBe(second);
	});

	test("uses project settings from each session workspace", () => {
		const first = mkdtempSync(join(tmpdir(), "harnez-workspace-test-"));
		const second = mkdtempSync(join(tmpdir(), "harnez-workspace-test-"));
		paths.push(first, second);
		for (const [dir, model] of [
			[first, "first-model"],
			[second, "second-model"],
		] as const) {
			mkdirSync(join(dir, ".harnez"));
			writeFileSync(
				join(dir, ".harnez/settings.json"),
				JSON.stringify({ model: { provider: "fake", model } }),
			);
		}
		const server = new HarnezServer(
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

	test("titles a session from only its first normal prompt", async () => {
		const { server } = harnez();
		const id = server.createSession();

		await server.command(id, {
			type: "prompt",
			text: "Fix the OAuth cancellation bug",
		});
		expect(server.store.list().find((session) => session.id === id)?.title).toBe(
			"OAuth cancellation bug Fix",
		);

		await server.command(id, {
			type: "prompt",
			text: "This later prompt must not replace the title",
		});
		expect(server.store.list().find((session) => session.id === id)?.title).toBe(
			"OAuth cancellation bug Fix",
		);
	});

	test("titles the idle steer command used by the TUI for its first prompt", async () => {
		const { server } = harnez();
		const id = server.createSession();

		await server.command(id, {
			type: "steer",
			text: "Fix OAuth cancellation in the login flow",
		});

		expect(server.store.list().find((session) => session.id === id)?.title).toBe(
			"Fix OAuth cancellation login flow",
		);
	});

	test("manually names a session without an automatic rename race", async () => {
		const { dir, server } = harnez();
		const id = server.createSession();
		let finishNaming!: (title: string) => void;
		(
			server as unknown as {
				namer: { generate: () => Promise<string> };
			}
		).namer.generate = () =>
			new Promise((resolve) => {
				finishNaming = resolve;
			});

		await server.command(id, { type: "prompt", text: "Automatic title" });
		await server.command(id, {
			type: "set-session-title",
			title: "  My   session  ",
		});
		finishNaming("Late automatic title");
		await Promise.resolve();

		expect(server.store.list().find((session) => session.id === id)?.title).toBe(
			"My session",
		);
		expect(server.store.claimNamingPrompt(id)).toBe(false);
		const restarted = new HarnezServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			fakeModels(),
			settings(dir),
		);
		expect(restarted.store.list().find((session) => session.id === id)?.title).toBe(
			"My session",
		);
		await expect(
			restarted.command(id, { type: "set-session-title", title: "   " }),
		).rejects.toThrow("session name is required");
	});

	test("consumes the first prompt while title generation is disabled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		mkdirSync(join(dir, "config"), { recursive: true });
		writeFileSync(
			join(dir, "config/settings.json"),
			JSON.stringify({ session: { title: { generated: false } } }),
		);
		const path = join(dir, "state.sqlite");
		const server = new HarnezServer(
			new SessionStore(path),
			dir,
			fakeModels(),
			settings(dir),
		);
		const id = server.createSession();

		await server.command(id, { type: "prompt", text: "first prompt" });
		expect(server.store.list().find((session) => session.id === id)?.title).toBeNull();

		writeFileSync(
			join(dir, "config/settings.json"),
			JSON.stringify({ session: { title: { generated: true } } }),
		);
		const restarted = new HarnezServer(
			new SessionStore(path),
			dir,
			fakeModels(),
			settings(dir),
		);
		await restarted.command(id, { type: "prompt", text: "second prompt" });
		expect(
			restarted.store.list().find((session) => session.id === id)?.title,
		).toBeNull();
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


	test("does not persist a credential after its queued write is cancelled", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
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
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const server = new HarnezServer(
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
		const { dir, server } = harnez();
		mkdirSync(join(dir, ".harnez/skills/review"), { recursive: true });
		writeFileSync(
			join(dir, ".harnez/skills/review/SKILL.md"),
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

	test("lists prompt templates for composer suggestions", async () => {
		const { dir, server } = harnez();
		mkdirSync(join(dir, ".harnez/prompts"), { recursive: true });
		writeFileSync(
			join(dir, ".harnez/prompts/review-pr.md"),
			"---\ndescription: Review an open pull request\n---\nRead the diff.",
		);
		const id = server.createSession();
		const events: ServerEvent[] = [];
		server.subscribe(id, (event) => events.push(event));

		await server.command(id, { type: "list-prompts" });

		expect(events).toContainEqual({
			type: "prompts",
			prompts: [
				{ name: "review-pr", description: "Review an open pull request" },
			],
		});
	});

	test("persists a selected non-OpenAI model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const server = new HarnezServer(
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

		const restarted = new HarnezServer(
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

		mkdirSync(join(dir, ".harnez"));
		writeFileSync(
			join(dir, ".harnez/settings.json"),
			'{"model":{"provider":"project","model":"model-2"}}',
		);
		const project = new HarnezServer(
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
			JSON.parse(readFileSync(join(dir, ".harnez/settings.json"), "utf8")),
		).toEqual({ model: { provider: "fake", model: "model-1" } });
	});

	test("cycles and persists the selected model's supported thinking level", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const models = fakeModels({
			reasoning: true,
			thinkingLevelMap: { high: null, xhigh: "xhigh", max: null },
		});
		const server = new HarnezServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			models,
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

		await server.command(id, { type: "cycle-thinking-level" });

		expect(server.store.modelConfig(id)).toEqual({
			provider: "fake",
			model: "model-1",
			thinkingLevel: "xhigh",
		});
		const persistedEvent: ServerEvent = {
			type: "model-config",
			config: {
				provider: "fake",
				model: "model-1",
				thinkingLevel: "xhigh",
			},
		};
		expect(events.at(-1)).toEqual(persistedEvent);
		expect(
			JSON.parse(readFileSync(join(dir, "config/settings.json"), "utf8")),
		).toEqual({
			model: {
				provider: "fake",
				model: "model-1",
				thinkingLevel: "xhigh",
			},
		});

		const restarted = new HarnezServer(
			new SessionStore(join(dir, "fresh.sqlite")),
			dir,
			models,
			settings(dir),
		);
		const restartedEvents: ServerEvent[] = [];
		restarted.subscribe(restarted.createSession(), (event) =>
			restartedEvents.push(event),
		);
		expect(restartedEvents).toContainEqual(persistedEvent);
	});

	test("persists the fast cycle and cycles through its available models", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const models = fakeModels({}, ["model-1", "model-2"]);
		const server = new HarnezServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			models,
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
		await server.command(id, {
			type: "set-fast-cycle",
			entries: [
				{ provider: "fake", model: "model-1" },
				{ provider: "fake", model: "gone" },
				{ provider: "fake", model: "model-2" },
			],
		});

		expect(events).toContainEqual({
			type: "fast-cycle",
			entries: [
				{ provider: "fake", model: "model-1" },
				{ provider: "fake", model: "gone" },
				{ provider: "fake", model: "model-2" },
			],
		});
		expect(
			JSON.parse(readFileSync(join(dir, "config/settings.json"), "utf8"))
				.fastCycle,
		).toEqual([
			{ provider: "fake", model: "model-1" },
			{ provider: "fake", model: "gone" },
			{ provider: "fake", model: "model-2" },
		]);

		/** The removed model is skipped, and the cycle wraps back around. */
		await server.command(id, { type: "cycle-model" });
		expect(server.store.modelConfig(id)).toEqual({
			provider: "fake",
			model: "model-2",
		});
		await server.command(id, { type: "cycle-model" });
		expect(server.store.modelConfig(id)).toEqual({
			provider: "fake",
			model: "model-1",
		});
	});

	test("keeps a thinking level per fast-cycle model", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const models = fakeModels(
			{ reasoning: true, thinkingLevelMap: { high: null, xhigh: "xhigh", max: null } },
			["model-1", "model-2"],
		);
		const server = new HarnezServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			models,
			settings(dir),
		);
		const id = server.createSession();
		await server.command(id, {
			type: "set-fast-cycle",
			entries: [
				{ provider: "fake", model: "model-1" },
				{ provider: "fake", model: "model-2" },
			],
		});
		await server.command(id, {
			type: "configure",
			provider: "fake",
			model: "model-1",
		});

		await server.command(id, { type: "cycle-thinking-level" });

		expect(
			JSON.parse(readFileSync(join(dir, "config/settings.json"), "utf8"))
				.fastCycle,
		).toEqual([
			{ provider: "fake", model: "model-1", thinkingLevel: "xhigh" },
			{ provider: "fake", model: "model-2" },
		]);

		/** Cycling models leaves the other entry alone and restores the level. */
		await server.command(id, { type: "cycle-model" });
		expect(server.store.modelConfig(id)).toEqual({
			provider: "fake",
			model: "model-2",
		});
		await server.command(id, { type: "cycle-model" });
		expect(server.store.modelConfig(id)).toEqual({
			provider: "fake",
			model: "model-1",
			thinkingLevel: "xhigh",
		});

		/** Reselecting the model with /model restores its remembered level too. */
		await server.command(id, {
			type: "configure",
			provider: "fake",
			model: "model-1",
		});
		expect(server.store.modelConfig(id)).toEqual({
			provider: "fake",
			model: "model-1",
			thinkingLevel: "xhigh",
		});
	});

	test("applies a thinking-level change made during a run to the next prompt", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const server = new HarnezServer(
			new SessionStore(join(dir, "state.sqlite")),
			dir,
			fakeModels({
				reasoning: true,
				thinkingLevelMap: { high: null, xhigh: "xhigh", max: null },
			}),
			settings(dir),
		);
		const id = server.createSession();
		await server.command(id, {
			type: "configure",
			provider: "fake",
			model: "model-1",
		});
		const internals = server as unknown as {
			runtime: {
				run: (input: { config: unknown }) => Promise<void>;
				forget: (id: string) => void;
			};
		};
		const configs: unknown[] = [];
		let forgets = 0;
		internals.runtime.forget = () => forgets++;
		let releaseFirstRun!: () => void;
		const firstRunGate = new Promise<void>(
			(resolve) => (releaseFirstRun = resolve),
		);
		internals.runtime.run = async ({ config }) => {
			configs.push(config);
			if (configs.length === 1) await firstRunGate;
		};
		const first = server.command(id, { type: "prompt", text: "first" });
		await until(() => expect(configs).toHaveLength(1));

		await expect(
			server.command(id, { type: "cycle-thinking-level" }),
		).resolves.toBeUndefined();
		expect(forgets).toBe(0);
		releaseFirstRun();
		await first;
		expect(forgets).toBe(1);
		await server.command(id, { type: "prompt", text: "second" });

		expect(configs).toEqual([
			{ provider: "fake", model: "model-1" },
			{ provider: "fake", model: "model-1", thinkingLevel: "xhigh" },
		]);
	});

	test("persists the thinking block preference", async () => {
		const { dir, server } = harnez();
		const id = server.createSession();

		await server.command(id, {
			type: "set-disable-thinking-blocks",
			disabled: true,
		});

		expect(
			JSON.parse(readFileSync(join(dir, "config/settings.json"), "utf8")),
		).toEqual({ disableThinkingBlocks: true });

		const restarted = new HarnezServer(
			new SessionStore(join(dir, "fresh.sqlite")),
			dir,
			fakeModels(),
			settings(dir),
		);
		const events: ServerEvent[] = [];
		restarted.subscribe(restarted.createSession(), (event) => events.push(event));
		expect(events).toContainEqual({
			type: "ui-settings",
			disableThinkingBlocks: true,
		});
	});

	test("rejects an unknown model before persisting it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const server = new HarnezServer(
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
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const server = new HarnezServer(
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
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const models = fakeModels();
		models.login = async () => {
			throw new Error("login failed");
		};
		const server = new HarnezServer(
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
		const dir = mkdtempSync(join(tmpdir(), "harnez-test-"));
		paths.push(dir);
		const server = new HarnezServer(
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
		const { server } = harnez();
		const id = server.createSession();
		await server.command(id, { type: "prompt", text: "/read note.txt" });
		expect(server.store.events(id)).toContainEqual({
			type: "error",
			message:
				"no model configured; use /model",
		});
	});

	test("queues a follow-up after completion", async () => {
		const { server } = harnez();
		(server as unknown as { runtime: { run: () => Promise<void> } }).runtime.run =
			async () => {};
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

	test("queues commands submitted while task construction is in progress", async () => {
		const { server } = harnez();
		const internals = server as unknown as {
			taskRunner: {
				createTask: (...args: never[]) => Promise<unknown>;
			};
			runtime: { run: (input: { text: string }) => Promise<void> };
		};
		const originalCreateTask = internals.taskRunner.createTask.bind(
			internals.taskRunner,
		);
		let constructionStarted!: () => void;
		let releaseConstruction!: () => void;
		let releaseFirstRun!: () => void;
		const constructing = new Promise<void>(
			(resolve) => (constructionStarted = resolve),
		);
		const constructionGate = new Promise<void>(
			(resolve) => (releaseConstruction = resolve),
		);
		const firstRunGate = new Promise<void>(
			(resolve) => (releaseFirstRun = resolve),
		);
		internals.taskRunner.createTask = async (...args) => {
			constructionStarted();
			await constructionGate;
			return await originalCreateTask(...args);
		};
		const prompts: string[] = [];
		internals.runtime.run = async ({ text }) => {
			prompts.push(text);
			if (prompts.length === 1) await firstRunGate;
		};
		const id = server.createSession();
		const first = server.command(id, { type: "prompt", text: "first" });
		await constructing;
		const second = server.command(id, { type: "prompt", text: "second" });
		releaseConstruction();
		await until(() => expect(prompts).toEqual(["first"]));
		releaseFirstRun();
		await Promise.all([first, second]);

		expect(prompts).toEqual(["first", "second"]);
		expect(
			server.store
				.events(id)
				.filter(
					(event) => event.type === "task-state" && event.state === "terminal",
				),
		).toHaveLength(2);
	});

	test("persists an explicit provider/model selection for resume", async () => {
		const { dir, server } = harnez();
		const id = server.createSession();
		await server.command(id, {
			type: "configure",
			provider: "openai-compatible",
			model: "test-model",
			baseUrl: "http://127.0.0.1:1/v1",
		});
		expect(
			new HarnezServer(
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
			const { dir, server } = harnez();
			writeFileSync(join(dir, "note.txt"), "hello");
			mkdirSync(join(dir, ".harnez/skills/review"), { recursive: true });
			writeFileSync(
				join(dir, ".harnez/skills/review/SKILL.md"),
				"---\nname: review\ndescription: review instructions\n---\nReview carefully.",
			);
			mkdirSync(join(dir, ".harnez/skills/manual"), { recursive: true });
			writeFileSync(
				join(dir, ".harnez/skills/manual/SKILL.md"),
				"---\nname: manual\ndescription: manual instructions\ndisable-model-invocation: true\n---\nManual only.",
			);
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
				thinkingLevel: "high",
			});
			await server.command(id, {
				type: "prompt",
				text: "Please /review /manual read note.txt",
			});
			const events = server.store.events(id);
			expect(calls).toBe(2);
			expect(requests[0]).toContain("Review carefully.");
			expect(requests[0]).toContain("Manual only.");
			expect(requests[0]).toContain('"reasoning_effort":"high"');
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
			const completed = server.store
				.events(id)
				.findLast((event) => event.type === "completed");
			if (completed?.type === "completed") {
				expect(typeof completed.modelDurationMs).toBe("number");
				expect(typeof completed.toolDurationMs).toBe("number");
			}
			expect(completed).toMatchObject({
				type: "completed",
				modelDurationMs: expect.any(Number),
				toolDurationMs: expect.any(Number),
			});
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("sends an expanded prompt template but keeps the typed text", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		const requests: string[] = [];
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				requests.push(await request.text());
				return new Response(
					'data: {"id":"one","choices":[{"delta":{"content":"done"},"finish_reason":null}]}\n\n' +
						'data: {"id":"one","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
						"data: [DONE]\n\n",
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		try {
			const { dir, server } = harnez();
			mkdirSync(join(dir, ".harnez/prompts"), { recursive: true });
			writeFileSync(
				join(dir, ".harnez/prompts/review-pr.md"),
				"---\ndescription: Review an open pull request\n---\nRead the diff and report defects.",
			);
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});

			await server.command(id, { type: "prompt", text: "/review-pr #42" });

			expect(requests[0]).toContain("Read the diff and report defects.");
			expect(requests[0]).toContain("#42");
			expect(requests[0]).not.toContain("/review-pr");
			expect(server.store.events(id)).toContainEqual({
				type: "user",
				text: "/review-pr #42",
			});
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
			const { server } = harnez();
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
				2,
			);
			expect(
				events
					.filter(
						(event): event is Extract<ServerEvent, { type: "command" }> =>
							event.type === "command" && event.state === "started",
					)
					.map((event) => event.id),
			).toEqual(["steer-1", "follow-1"]);
			expect(
				events
					.filter(
						(event): event is Extract<ServerEvent, { type: "user" }> =>
							event.type === "user",
					)
					.map((event) => [event.id, event.text]),
			).toEqual([
				[undefined, "first"],
				["steer-1", "new direction"],
				["follow-1", "afterwards"],
			]);
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("steering aborts a running tool turn", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				return sseResponse(
					calls === 1
						? toolCallChunks("call-wait", "bash", { command: "sleep 5" })
						: textChunks("redirected"),
				);
			},
		});
		try {
			const { server } = harnez();
			const id = server.createSession();
			let toolStarted!: () => void;
			const toolCall = new Promise<void>((resolve) => {
				toolStarted = resolve;
			});
			server.subscribe(id, (event) => {
				if (event.type === "tool-call" && event.name === "bash") toolStarted();
			});
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			const running = server.command(id, { type: "prompt", text: "wait" });
			await Promise.race([
				toolCall,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("tool did not start")), 1_000),
				),
			]);
			await server.command(id, {
				type: "steer",
				id: "steer-1",
				text: "new direction",
			});
			await Promise.race([
				running,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error("tool steering timed out")), 1_000),
				),
			]);
			expect(calls).toBe(2);
			const aborted = server.store
				.events(id)
				.filter((event) => event.type === "aborted");
			expect(aborted).toHaveLength(1);
			expect(aborted[0]).toMatchObject({
				type: "aborted",
				durationMs: expect.any(Number),
				modelDurationMs: expect.any(Number),
				toolDurationMs: expect.any(Number),
			});
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("drains an independent follow-up after a runtime error", async () => {
		const { server } = harnez();
		let calls = 0;
		(server as unknown as { runtime: { run: () => Promise<void> } }).runtime.run =
			async () => {
				calls++;
				throw new Error("runtime failed");
			};
		const id = server.createSession();
		await server.command(id, {
			type: "follow-up",
			id: "follow-1",
			text: "after failure",
		});
		await server.command(id, { type: "prompt", text: "fail" });
		expect(calls).toBe(2);
		expect(
			server.store.events(id).some((event) => event.type === "completed"),
		).toBe(false);
	});

	test("blocks only an explicitly success-dependent queued task", async () => {
		const { server } = harnez();
		let calls = 0;
		(server as unknown as { runtime: { run: () => Promise<void> } }).runtime.run =
			async () => {
				calls++;
				throw new Error("runtime failed");
			};
		const id = server.createSession();
		await server.command(id, {
			type: "enqueue",
			id: "dependent-1",
			text: "only after success",
			requirePredecessorSuccess: true,
		});
		await server.command(id, { type: "prompt", text: "fail" });

		expect(calls).toBe(1);
		expect(server.store.events(id)).toContainEqual({
			type: "task-state",
			taskId: "dependent-1",
			state: "blocked",
		});
	});

	test("resumes, cancels, or replaces a blocked queued task", async () => {
		for (const recovery of ["resume", "cancel", "replace"] as const) {
			const { server } = harnez();
			const prompts: string[] = [];
			(
				server as unknown as {
					runtime: { run: (input: { text: string }) => Promise<void> };
				}
			).runtime.run = async ({ text }) => {
				prompts.push(text);
				if (prompts.length === 1) throw new Error("runtime failed");
			};
			const id = server.createSession();
			await server.command(id, {
				type: "enqueue",
				id: "blocked-1",
				text: "dependent",
				requirePredecessorSuccess: true,
			});
			await server.command(id, {
				type: "follow-up",
				id: "after-1",
				text: "after",
			});
			await server.command(id, { type: "prompt", text: "fail" });

			if (recovery === "resume")
				await server.command(id, {
					type: "resume-queued",
					taskId: "blocked-1",
				});
			else if (recovery === "cancel")
				await server.command(id, {
					type: "cancel-queued",
					taskId: "blocked-1",
				});
			else
				await server.command(id, {
					type: "replace-queued",
					taskId: "blocked-1",
					id: "replacement-1",
					text: "replacement",
				});

			expect(prompts).toEqual(
				recovery === "resume"
					? ["fail", "dependent", "after"]
					: recovery === "cancel"
						? ["fail", "after"]
						: ["fail", "replacement", "after"],
			);
			expect(server.store.events(id)).toContainEqual({
				type: "command",
				id: "blocked-1",
				command: "follow-up",
				state: recovery === "resume" ? "queued" : "cancelled",
			});
		}
	});

	test("supersedes during an in-flight tool call and drains the replacement", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				return sseResponse(
					calls === 1
						? toolCallChunks("call-wait", "bash", { command: "sleep 5" })
						: textChunks("replacement complete"),
				);
			},
		});
		try {
			const { server } = harnez();
			const id = server.createSession();
			let toolStarted!: () => void;
			const toolCall = new Promise<void>((resolve) => (toolStarted = resolve));
			let firstTaskId: string | undefined;
			server.subscribe(id, (event) => {
				if (event.type === "task-state" && event.state === "running")
					firstTaskId ??= event.taskId;
				if (event.type === "tool-call" && event.name === "bash") toolStarted();
			});
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			const running = server.command(id, { type: "prompt", text: "wait" });
			await toolCall;
			const steering = server.command(id, {
				type: "steer",
				id: "stale-steer",
				text: "stale direction",
			});
			const superseding = server.command(id, {
				type: "supersede",
				id: "replacement-1",
				text: "continue safely",
			});
			await Promise.all([steering, superseding]);
			await running;

			const events = server.store.events(id);
			expect(calls).toBe(2);
			expect(
				events
					.filter(
						(event): event is Extract<ServerEvent, { type: "task-state" }> =>
							event.type === "task-state" && event.state === "terminal",
					)
					.map((event) => event.status),
			).toEqual(["superseded", "completed"]);
			expect(events).not.toContainEqual({
				type: "error",
				message: "TASK_ALREADY_CANCELLING",
			});
			expect(events).toContainEqual({
				type: "command",
				id: "stale-steer",
				command: "steer",
				state: "replaced",
			});
			expect(
				events
					.filter(
						(event): event is Extract<ServerEvent, { type: "command" }> =>
							event.type === "command" && event.id === "replacement-1",
					)
					.map((event) => event.state),
			).toEqual(["queued", "started", "finished"]);
			if (!firstTaskId) throw new Error("missing first task id");
			expect(
				server.store
					.taskLedger(id, firstTaskId)
					.filter((entry) => entry.type === "cancellation_requested"),
			).toHaveLength(1);
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("does not retain output from a tool that settles after cancellation", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		const originalExecute = BashTool.prototype.execute;
		let toolStarted!: () => void;
		let releaseTool!: () => void;
		const started = new Promise<void>((resolve) => (toolStarted = resolve));
		const toolGate = new Promise<void>((resolve) => (releaseTool = resolve));
		BashTool.prototype.execute = async () => {
			toolStarted();
			await toolGate;
			return "late output";
		};
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				return sseResponse(
					toolCallChunks("call-wait", "bash", { command: "wait" }),
				);
			},
		});
		try {
			const { server } = harnez();
			const id = server.createSession();
			const context = (
				server as unknown as {
					context: {
						recordObservation: (...args: never[]) => unknown;
					};
				}
			).context;
			const recordObservation = context.recordObservation.bind(context);
			let observations = 0;
			context.recordObservation = (...args) => {
				observations++;
				return recordObservation(...args);
			};
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			const running = server.command(id, { type: "prompt", text: "wait" });
			await started;
			const active = (
				server as unknown as {
					session: (sessionId: string) => {
						running?: { task: { cancellationGraceMs: number } };
					};
				}
			).session(id).running;
			if (!active) throw new Error("missing active task");
			active.task.cancellationGraceMs = 0;
			await server.command(id, {
				type: "steer",
				id: "cancelled-steer",
				text: "do not resume",
			});
			await server.command(id, { type: "abort" });
			releaseTool();
			await running;
			expect(observations).toBe(0);
			expect(calls).toBe(1);
			expect(server.store.events(id)).toContainEqual({
				type: "command",
				id: "cancelled-steer",
				command: "steer",
				state: "cancelled",
			});
		} finally {
			BashTool.prototype.execute = originalExecute;
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
			const { server } = harnez();
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
	test("projects terminal conversation after restart without tool traffic", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
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
			const { dir, server } = harnez(3_000);
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

			const restarted = new HarnezServer(
				new SessionStore(join(dir, "state.sqlite")),
				dir,
				undefined,
				undefined,
				{ contextBudget: 3_000 },
			);
			await restarted.command(id, {
				type: "prompt",
				text: "continue ".repeat(250),
			});

			expect(calls).toBe(3);
			const status = restarted.store
				.events(id)
				.findLast((event) => event.type === "context-status");
			expect(status).toMatchObject({ type: "context-status", budget: 3_000 });
			if (status?.type === "context-status") {
				/** The externalized read output is history the prompt no longer pays for. */
				expect(status.historyTokens).toBeGreaterThan(status.liveTokens);
				expect(status.parkedObservations).toBeGreaterThan(0);
			}
			expect(JSON.stringify(bodies[2])).not.toContain(output);
			expect(JSON.stringify(bodies[2])).not.toContain(
				"Earlier read output was compacted",
			);
			expect(JSON.stringify(bodies[2])).not.toContain("observation://obs-");
			expect(JSON.stringify(bodies[2])).toContain("done");
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
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("discovers the context tools and pages an observation by argument", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		const bodies: { messages: { content?: string; tool_call_id?: string }[] }[] =
			[];
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const body = (await request.json()) as {
					messages: { content?: string; tool_call_id?: string }[];
				};
				bodies.push(body);
				calls++;
				const chunks =
					calls === 1
						? toolCallChunks("call-search", "capabilities_search", {
								query: "recall observation",
							})
						: calls === 2
							? toolCallChunks("call-read", "read", { path: "note.txt" })
							: calls === 3
								? toolCallChunks("call-recall", "recall_observation", {
										reference: observationReference(body, "call-read"),
										offset: 5,
										limit: 5,
									})
								: doneChunks();
				return sseResponse(chunks);
			},
		});
		try {
			const { dir, server } = harnez();
			writeFileSync(
				join(dir, "note.txt"),
				`0123456789ABCDE${"x".repeat(20_000)}`,
			);
			const id = server.createSession();
			await server.command(id, {
				type: "configure",
				provider: "openai-compatible",
				model: "test-model",
				baseUrl: `http://127.0.0.1:${provider.port}/v1`,
			});
			await server.command(id, { type: "prompt", text: "find a way to recall" });

			expect(calls).toBe(4);
			/**
			 * The registry has to answer for the tools the model is already holding;
			 * an empty result here is what sends it reading the session database by
			 * hand instead of calling `recall_observation`.
			 */
			const found = bodies[1]?.messages.find(
				(message) => message.tool_call_id === "call-search",
			)?.content;
			expect(found).toContain("tool:recall_observation");
			expect(found).toContain("Pages with offset and limit");
			expect(
				bodies[3]?.messages.find(
					(message) => message.tool_call_id === "call-recall",
				)?.content,
			).toBe(
				"56789\n\n[showing characters 5-10 of 20015; continue with offset=10]",
			);
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("pins context and recalls an exact archived observation slice", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
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
			const { dir, server } = harnez();
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
			bodies[2]!.messages.find(
				(message) => message.tool_call_id === "call-read",
			)?.content?.length,
		).toBeLessThanOrEqual(16_000);
			/** A five-character window on a 20k observation has to say so. */
			expect(
			bodies[3]!.messages.find(
				(message) => message.tool_call_id === "call-recall",
			)?.content,
		).toBe(
			"ABCDE\n\n[showing characters 10-15 of 20015; continue with offset=15]",
		);
			expect(
			server.store.contextItems(id).some(
				(item) =>
					item.kind === "pinned-note" &&
					JSON.stringify(item.payload).includes("keep this needle"),
			),
		).toBe(true);
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("does not project predecessor episode traffic into a new task", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		const bodies: {
			messages: { role: string; content?: string; tool_call_id?: string }[];
			tools?: {
				function: { name: string; parameters: Record<string, unknown> };
			}[];
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
			const { dir, server } = harnez(3_200);
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
			const episodeParameters = bodies[0]?.tools?.find(
				(tool) => tool.function.name === "episode",
			)?.function.parameters;
			expect(episodeParameters).toMatchObject({
				type: "object",
				required: ["action"],
				additionalProperties: false,
			});
			expect(episodeParameters).not.toHaveProperty("anyOf");
			expect(episodeParameters).not.toHaveProperty("oneOf");
			expect(JSON.stringify(bodies.at(-1))).not.toContain(
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
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("summarizes an over-budget prompt before calling the provider", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
		let calls = 0;
		const provider = Bun.serve({
			port: 0,
			fetch: () => {
				calls++;
				return sseResponse(doneChunks());
			},
		});
		try {
			const { server } = harnez(3_000);
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
			expect(calls).toBe(1);
			expect(
				server.store
					.contextItems(id)
					.some((item) => item.reason === "rolling summary"),
			).toBe(true);
			expect(
				server.store
					.events(id)
					.some((event) => event.type === "context-budget-error"),
			).toBe(false);
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("compacts assistant turns and rolls old user messages forward", async () => {
		process.env["HARNESS_OPENAI_API_KEY"] = "test";
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
			const { server } = harnez(3_000);
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
			const liveUsers = server.store
				.contextItems(id)
				.filter((item) => item.kind === "user" && item.lifecycle === "pinned");
			expect(liveUsers).toHaveLength(4);
			expect(liveUsers.some((item) => item.reason === "rolling summary")).toBe(
				true,
			);
			const compaction = server.store
				.events(id)
				.find((event) => event.type === "context-compaction");
			expect(compaction).toMatchObject({ type: "context-compaction" });
			if (compaction?.type === "context-compaction") {
				expect(compaction.evictedCount).toBeGreaterThan(0);
				expect(compaction.tokensAfter).toBeLessThan(compaction.tokensBefore);
			}
		} finally {
			provider.stop(true);
			delete process.env["HARNESS_OPENAI_API_KEY"];
		}
	});

	test("uses named keyless providers for catalogs, fast cycling, and streaming", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-named-provider-"));
		paths.push(dir);
		let requestBody = "";
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				requestBody = await request.text();
				return sseResponse(textChunks("named done"));
			},
		});
		try {
			mkdirSync(join(dir, "config"));
			writeFileSync(
				join(dir, "config/settings.json"),
				JSON.stringify({
					providers: {
						ollama: {
							type: "openai-compatible",
							baseUrl: `http://127.0.0.1:${provider.port}/v1`,
							auth: "none",
							models: ["qwen3-coder:30b", "qwen3-coder:next"],
						},
					},
				}),
			);
			const server = new HarnezServer(
				new SessionStore(join(dir, "state.sqlite")),
				dir,
				undefined,
				settings(dir),
			);
			const id = server.createSession();
			const events: ServerEvent[] = [];
			server.subscribe(id, (event) => events.push(event));
			await server.command(id, { type: "list-models" });
			expect(events).toContainEqual({
				type: "models",
				models: expect.arrayContaining([
					expect.objectContaining({ provider: "ollama", id: "qwen3-coder:30b" }),
				]),
			});
			await server.command(id, {
				type: "configure",
				provider: "ollama",
				model: "qwen3-coder:30b",
			});
			await server.command(id, {
				type: "set-fast-cycle",
				entries: [
					{ provider: "ollama", model: "qwen3-coder:30b" },
					{ provider: "ollama", model: "qwen3-coder:next" },
				],
			});
			await server.command(id, { type: "cycle-model" });
			expect(server.store.modelConfig(id)).toEqual({
				provider: "ollama",
				model: "qwen3-coder:next",
			});
			await server.command(id, {
				type: "configure",
				provider: "ollama",
				model: "qwen3-coder:30b",
			});
			await server.command(id, { type: "prompt", text: "hello" });
			expect(requestBody).toContain('"model":"qwen3-coder:30b"');
		} finally {
			provider.stop(true);
		}
	});

	test("isolates named API-key credentials and rejects unknown named models before persistence", async () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-named-auth-"));
		paths.push(dir);
		process.env["XDG_CONFIG_HOME"] = join(dir, "xdg");
		let authorization = "";
		const provider = Bun.serve({
			port: 0,
			fetch: async (request) => {
				authorization = request.headers.get("authorization") ?? "";
				return sseResponse(textChunks("authenticated"));
			},
		});
		try {
			const global = join(dir, "settings.json");
			writeFileSync(
				global,
				JSON.stringify({
					providers: {
						"company-llm": {
							type: "openai-compatible",
							baseUrl: `http://127.0.0.1:${provider.port}/v1`,
							auth: "api-key",
							models: ["company-coder"],
						},
					},
				}),
			);
			const auth = join(dir, "xdg/harnez/auth.json");
			mkdirSync(join(dir, "xdg/harnez"), { recursive: true });
			writeFileSync(auth, JSON.stringify({ "openai-compatible": { type: "api_key", key: "legacy" } }));
			const server = new HarnezServer(
				new SessionStore(join(dir, "state.sqlite")), dir, undefined,
				new SettingsStore(global, join(dir, ".harnez/settings.json")),
			);
			const id = server.createSession();
			const events: ServerEvent[] = [];
			server.subscribe(id, (event) => events.push(event));
			await server.command(id, { type: "login", provider: "company-llm", authType: "api_key" });
			await until(() => expect(events.some((event) => event.type === "auth-prompt")).toBe(true));
			const prompt = events.find((event) => event.type === "auth-prompt");
			if (!prompt || prompt.type !== "auth-prompt") throw new Error("missing API-key prompt");
			await server.command(id, { type: "auth-answer", promptId: prompt.prompt.id, value: "secret" });
			await until(() => expect(events).toContainEqual({ type: "auth-completed", provider: "company-llm" }));
			expect(JSON.parse(readFileSync(auth, "utf8"))).toEqual({
				"openai-compatible": { type: "api_key", key: "legacy" },
				"company-llm": { type: "api_key", key: "secret" },
			});
			await server.command(id, { type: "configure", provider: "company-llm", model: "company-coder" });
			await server.command(id, { type: "prompt", text: "hello" });
			expect(authorization).toBe("Bearer secret");
			await expect(server.command(id, { type: "configure", provider: "company-llm", model: "missing" })).rejects.toThrow("unknown model company-llm/missing");
			expect(server.store.modelConfig(id)).toEqual({ provider: "company-llm", model: "company-coder" });
		} finally {
			provider.stop(true);
		}
	});

	test("resolves provider definitions per session workspace and rejects collisions", async () => {
		const root = mkdtempSync(join(tmpdir(), "harnez-provider-workspaces-"));
		const first = join(root, "first");
		const second = join(root, "second");
		paths.push(root);
		process.env["XDG_CONFIG_HOME"] = join(root, "xdg");
		for (const [workspace, model] of [[first, "first-model"], [second, "second-model"]] as const) {
			mkdirSync(join(workspace, ".harnez"), { recursive: true });
			writeFileSync(join(workspace, ".harnez/settings.json"), JSON.stringify({ providers: { local: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1", auth: "none", models: [model] } } }));
		}
		const server = new HarnezServer(
			new SessionStore(join(root, "state.sqlite")), first, undefined,
			new SettingsStore(join(root, "xdg/harnez/settings.json"), join(first, ".harnez/settings.json")),
		);
		const firstId = server.createSession(first);
		const secondId = server.createSession(second);
		const firstEvents: ServerEvent[] = [];
		const secondEvents: ServerEvent[] = [];
		server.subscribe(firstId, (event) => firstEvents.push(event));
		server.subscribe(secondId, (event) => secondEvents.push(event));
		await Promise.all([server.command(firstId, { type: "list-models", provider: "local" }), server.command(secondId, { type: "list-models", provider: "local" })]);
		expect(firstEvents).toContainEqual({ type: "models", models: [expect.objectContaining({ provider: "local", id: "first-model" })] });
		expect(secondEvents).toContainEqual({ type: "models", models: [expect.objectContaining({ provider: "local", id: "second-model" })] });
		for (const id of ["openai-compatible", "openai"])
			expect(() => createHarnezModels(new JsonCredentialStore(join(root, `${id}.json`)), { [id]: { type: "openai-compatible", baseUrl: "http://localhost:11434/v1", auth: "none", models: ["model"] } })).toThrow(id);
	});

});
