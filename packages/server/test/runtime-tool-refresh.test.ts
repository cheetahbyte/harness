import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialStore } from "@earendil-works/pi-ai";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type ToolCall,
} from "@earendil-works/pi-ai";

import { HarnezAgentRuntime } from "../src/agent/runtime";
import { CapabilityCatalog } from "../src/capabilities/catalog";
import { CapabilityContext } from "../src/capabilities/context";
import { ContextManager } from "../src/context/manager";
import { mcpCapabilities } from "../src/mcp/capabilities";
import type { McpToolDescriptor } from "../src/mcp/registry";
import { SessionStore } from "../src/sessions/store";
import { TaskRuntime } from "../src/task-runtime";
import type { RuntimeEvent } from "../src/telemetry/events";
import { sanitizeEvent } from "../src/telemetry/runtime";
import { CoreTools } from "../src/tools";

/**
 * Guards `HarnezAgentRuntime` itself rather than a copy of its wiring. Pi
 * snapshots the tool list when a prompt starts, so if the runtime stops
 * re-reading `agent.state.tools` between turns, a tool published by
 * `tools_load` silently becomes uncallable for the rest of the run.
 */

const GENERATION = "binding-1";

const descriptor: McpToolDescriptor = {
	server: "echo",
	tool: "shout",
	name: "mcp__echo__shout",
	description: "Shouts the given text.",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
	readOnly: false,
};

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "fake",
		model: "model-1",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: content.some((part) => part.type === "toolCall")
			? "toolUse"
			: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function toolCall(
	name: string,
	id: string,
	args: Record<string, unknown> = {},
): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

/** A model registry whose streamed turns are fixed in advance. */
function scriptedModels(turns: readonly AssistantMessage["content"][]) {
	const model = {
		id: "model-1",
		name: "Model 1",
		provider: "fake",
		api: "anthropic",
		contextWindow: 100_000,
		maxTokens: 1_000,
		reasoning: false,
	};
	let turn = 0;
	const requests: unknown[] = [];
	return {
		requests,
		getModel: () => model,
		getProviders: () => [],
		getProvider: () => undefined,
		getAvailable: async () => [model],
		streamSimple: (_model: unknown, context: unknown): AssistantMessageEventStream => {
			requests.push(context);
			const stream = createAssistantMessageEventStream();
			const content = turns[Math.min(turn, turns.length - 1)] ?? [];
			turn += 1;
			const message = assistant(content);
			queueMicrotask(() => {
				content.forEach((part, contentIndex) => {
					if (part.type === "toolCall")
						stream.push({
							type: "toolcall_end",
							contentIndex,
							toolCall: part,
							partial: message,
						});
				});
				stream.push({
					type: "done",
					reason: message.stopReason as "stop" | "toolUse",
					message,
				});
			});
			return stream;
		},
	};
}

test("step capability context reaches one inference", async () => {
	const dir = mkdtempSync(join(tmpdir(), "harnez-runtime-step-"));
	paths.push(dir);
	const store = new SessionStore(join(dir, "state.sqlite"));
	const sessionId = store.create(dir);
	const context = new ContextManager(store);
	const tools = new CoreTools(dir);
	const catalog = new CapabilityCatalog(
		tools.capabilities(GENERATION),
		GENERATION,
	);
	const snapshot = catalog.snapshot({
		tool: { maxLevel: "execute", confirmation: "none" },
		skill: { maxLevel: "activate" },
	});
	const ref = snapshot.reference("tool:read", "operator");
	const capabilityContext = new CapabilityContext(
		{},
		(base, items) => ({ base, items }),
	);
	capabilityContext.admit({
		capability: ref,
		scope: "step",
		contentHash: "step",
		content: "ONE-INFERENCE-INSTRUCTIONS",
		accountant: {
			modelId: "model-1",
			serializerVersion: "test",
			method: "conservative_estimate",
			count: () => 1,
		},
	});
	const task = new TaskRuntime(
		snapshot,
		capabilityContext,
		crypto.getRandomValues(new Uint8Array(32)),
	);
	task.load(ref);
	await Bun.write(join(dir, "note.txt"), "hello");
	const models = scriptedModels([
		[toolCall("read", "call-read", { path: "note.txt" })],
		[{ type: "text", text: "done" }],
	]);
	const runtime = new HarnezAgentRuntime({
		credentials: {} as CredentialStore,
		modelsFor: () => models as never,
		store,
		context,
	});

	await runtime.run({
		sessionId,
		text: "read once",
		config: { provider: "fake", model: "model-1" },
		tools,
		task,
		skills: [],
		mcpTools: [],
		mcp: { call: async () => "" },
		signal: new AbortController().signal,
		emit: () => {},
	});

	expect(JSON.stringify(models.requests[0])).toContain(
		"ONE-INFERENCE-INSTRUCTIONS",
	);
	expect(JSON.stringify(models.requests[1])).not.toContain(
		"ONE-INFERENCE-INSTRUCTIONS",
	);
	expect(task.context.items()).toEqual([]);
}, 30_000);

test("model telemetry carries the provider request and terminal response", async () => {
	const dir = mkdtempSync(join(tmpdir(), "harnez-runtime-telemetry-"));
	paths.push(dir);
	const store = new SessionStore(join(dir, "state.sqlite"));
	const sessionId = store.create(dir);
	const context = new ContextManager(store);
	const tools = new CoreTools(dir);
	const snapshot = new CapabilityCatalog(
		tools.capabilities(GENERATION),
		GENERATION,
	).snapshot({
		tool: { maxLevel: "execute", confirmation: "none" },
		skill: { maxLevel: "activate" },
	});
	const task = new TaskRuntime(
		snapshot,
		new CapabilityContext({}, (base, items) => ({ base, items })),
		crypto.getRandomValues(new Uint8Array(32)),
	);
	const models = scriptedModels([[{ type: "text", text: "captured answer" }]]);
	const events: RuntimeEvent[] = [];
	const runtime = new HarnezAgentRuntime({
		credentials: {} as CredentialStore,
		modelsFor: () => models as never,
		store,
		context,
		sink: (event) => events.push(event),
	});

	await runtime.run({
		sessionId,
		text: "captured question",
		images: [
			{ id: "image-1", mimeType: "image/png", data: "private-image-bytes" },
		],
		config: { provider: "fake", model: "model-1" },
		tools,
		task,
		skills: [],
		mcpTools: [],
		mcp: { call: async () => "" },
		signal: new AbortController().signal,
		emit: () => {},
	});

	const started = events.find(
		(event) => event.type === "model.request.started",
	)!;
	const completed = events.find(
		(event) => event.type === "model.request.completed",
	)!;
	expect(JSON.stringify(started["prompt"])).toContain("captured question");
	expect(JSON.stringify(completed["response"])).toContain("captured answer");
	expect(started.requestId).toBe(completed.requestId);
	const captured = sanitizeEvent(started, new Set(["prompts", "paths"]));
	expect(captured["prompt"]).not.toContain("private-image-bytes");
	expect(captured["prompt"]).toContain('"mimeType":"image/png"');
	expect(sanitizeEvent(started)["prompt"]).toBeUndefined();
}, 30_000);

test("a tool loaded mid-run is callable on the next turn of the same run", async () => {
	const dir = mkdtempSync(join(tmpdir(), "harnez-runtime-"));
	paths.push(dir);
	const store = new SessionStore(join(dir, "state.sqlite"));
	const sessionId = store.create(dir);
	const context = new ContextManager(store);

	const tools = new CoreTools(dir);
	const catalog = new CapabilityCatalog(
		[
			...tools.capabilities(GENERATION),
			...mcpCapabilities([descriptor], GENERATION),
		],
		GENERATION,
	);
	const snapshot = catalog.snapshot({
		tool: { maxLevel: "execute", confirmation: "none" },
		skill: { maxLevel: "activate" },
	});
	const task = new TaskRuntime(
		snapshot,
		new CapabilityContext({}, (base, items) => ({ base, items })),
		crypto.getRandomValues(new Uint8Array(32)),
	);

	const calls: string[] = [];
	const models = scriptedModels([
		[toolCall("tools_load", "call-1", { id: "tool:mcp__echo__shout" })],
		[toolCall("mcp__echo__shout", "call-2", { text: "hello" })],
		[{ type: "text", text: "done" }],
	]);
	const telemetry: RuntimeEvent[] = [];
	const runtime = new HarnezAgentRuntime({
		credentials: {} as CredentialStore,
		modelsFor: () => models as never,
		store,
		context,
		sink: (event) => telemetry.push(event),
	});

	const results: string[] = [];
	await runtime.run({
		sessionId,
		text: "search please",
		config: { provider: "fake", model: "model-1" },
		tools,
		task,
		skills: [],
		mcpTools: [descriptor],
		mcp: {
			call: async (server: string, tool: string) => {
				calls.push(`${server}/${tool}`);
				return "SHOUTED";
			},
		},
		signal: new AbortController().signal,
		emit: (event) => {
			if (event.type === "tool-result") results.push(event.output);
		},
	});

	expect(results[0]).toBe("Loaded mcp__echo__shout");
	// Without the refresh this is "Tool mcp__echo__shout not found".
	expect(results[1]).toBe("SHOUTED");

	// The second turn must reach the server rather than "Tool ... not found".
	expect(calls).toEqual(["echo/shout"]);
	const builtInStart = telemetry.find(
		(event) =>
			event.type === "tool.call.started" && event.tool === "tools_load",
	)!;
	const builtInEnd = telemetry.find(
		(event) =>
			event.type === "tool.call.completed" && event.tool === "tools_load",
	)!;
	const mcpStart = telemetry.find(
		(event) =>
			event.type === "tool.call.started" && event.tool === descriptor.name,
	)!;
	const mcpEnd = telemetry.find(
		(event) =>
			event.type === "tool.call.completed" && event.tool === descriptor.name,
	)!;
	expect(JSON.stringify(builtInStart["toolArguments"])).toContain(
		"tool:mcp__echo__shout",
	);
	expect(JSON.stringify(builtInEnd["toolResults"])).toContain(
		"Loaded mcp__echo__shout",
	);
	expect(JSON.stringify(mcpStart["mcpPayload"])).toContain("hello");
	expect(JSON.stringify(mcpEnd["mcpPayload"])).toContain("SHOUTED");
	expect(
		sanitizeEvent(builtInStart, new Set(["tool-arguments"]))[
			"toolArguments"
		],
	).toBeDefined();
	expect(
		sanitizeEvent(mcpStart, new Set(["tool-arguments"]))["mcpPayload"],
	).toBeUndefined();
	expect(
		sanitizeEvent(mcpStart, new Set(["mcp-payloads"]))["mcpPayload"],
	).toBeDefined();
	expect(
		sanitizeEvent(builtInStart, new Set(["mcp-payloads"]))[
			"toolArguments"
		],
	).toBeUndefined();
}, 30_000);
