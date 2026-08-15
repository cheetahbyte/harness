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
	return {
		getModel: () => model,
		getProviders: () => [],
		getProvider: () => undefined,
		getAvailable: async () => [model],
		streamSimple: (): AssistantMessageEventStream => {
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
	const runtime = new HarnezAgentRuntime({
		credentials: {} as CredentialStore,
		modelsFor: () => models as never,
		store,
		context,
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
}, 30_000);
