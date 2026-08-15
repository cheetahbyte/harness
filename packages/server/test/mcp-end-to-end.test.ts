import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";

import { agentTools } from "../src/agent/tools";
import { CapabilityCatalog } from "../src/capabilities/catalog";
import { CapabilityContext } from "../src/capabilities/context";
import type { ContextManager } from "../src/context/manager";
import { mcpCapabilities } from "../src/mcp/capabilities";
import { type McpConfigScan, loadMcpConfig, MCP_SCHEMA_ID } from "../src/mcp/config";
import { McpRegistry } from "../src/mcp/registry";
import { TaskRuntime } from "../src/task-runtime";
import { CoreTools } from "../src/tools";

/**
 * The whole path a real session takes: a configured MCP server, the capability
 * catalog, `tools_load`, and a second model turn that actually calls the tool.
 * The pieces were each covered on their own while the seam between them was
 * broken, so this exercises them together.
 */

const FIXTURE = join(import.meta.dir, "fixtures/mcp-echo-server.ts");
const GENERATION = "binding-1";

const paths: string[] = [];
const registries: McpRegistry[] = [];
afterEach(async () => {
	await Promise.all(registries.splice(0).map((registry) => registry.close()));
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

const model = {
	id: "test-model",
	api: "anthropic",
	provider: "test",
	contextWindow: 100_000,
	maxTokens: 1_000,
} as unknown as Model<never>;

const contextManager = {
	recordObservation: () => ({ id: "observation-1" }),
} as unknown as ContextManager;

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "test",
		model: "test-model",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: content.some((part) => part.type === "toolCall")
			? "toolUse"
			: "stop",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function scriptedStream(
	turns: readonly AssistantMessage["content"][],
): () => AssistantMessageEventStream {
	let turn = 0;
	return () => {
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
	};
}

function toolCall(
	name: string,
	id: string,
	args: Record<string, unknown> = {},
): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function startServer(): McpRegistry {
	const root = mkdtempSync(join(tmpdir(), "harnez-mcp-e2e-"));
	paths.push(root);
	mkdirSync(join(root, "bin"), { recursive: true });
	const launcher = join(root, "bin/server");
	writeFileSync(launcher, `#!/bin/sh\nexec bun ${JSON.stringify(FIXTURE)} "$@"\n`);
	chmodSync(launcher, 0o755);
	writeFileSync(
		join(root, "mcp.json"),
		JSON.stringify({
			$schema: MCP_SCHEMA_ID,
			mcpServers: { echo: { type: "stdio", command: "./bin/server" } },
		}),
	);
	const load = (workspace: string): McpConfigScan =>
		loadMcpConfig(workspace, {
			sources: [{ path: join(root, "mcp.json"), root }],
			dataRoot: (name) => join(root, "state", name),
		});
	const registry = new McpRegistry(root, { load });
	registries.push(registry);
	return registry;
}

function toolResult(agent: Agent, toolCallId: string): string {
	const message = agent.state.messages.find(
		(entry) =>
			(entry as { role?: string }).role === "toolResult" &&
			(entry as { toolCallId?: string }).toolCallId === toolCallId,
	) as { content?: { type: string; text?: string }[] } | undefined;
	return (message?.content ?? [])
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("");
}

test("loads an MCP tool and calls it on the following turn", async () => {
	const registry = startServer();
	const snapshot = await registry.snapshot();
	expect(snapshot.diagnostics).toEqual([]);

	const tools = new CoreTools(process.cwd());
	const catalog = new CapabilityCatalog(
		[
			...tools.capabilities(GENERATION),
			...mcpCapabilities(snapshot.tools, GENERATION),
		],
		GENERATION,
	);
	const capabilities = catalog.snapshot({
		tool: { maxLevel: "execute", confirmation: "none" },
		skill: { maxLevel: "activate" },
	});
	const task = new TaskRuntime(
		capabilities,
		new CapabilityContext({}, (base, items) => ({ base, items })),
		crypto.getRandomValues(new Uint8Array(32)),
	);

	// Mirrors HarnezAgentRuntime.createAgent, including the tool refresh that
	// makes a freshly loaded tool reachable on the next turn.
	const admit = (tool: AgentTool): void => {
		if (agent.state.tools.some((existing) => existing.name === tool.name)) return;
		agent.state.tools = [...agent.state.tools, tool];
	};
	const agent: Agent = new Agent({
		initialState: {
			model,
			thinkingLevel: "off",
			systemPrompt: "test",
			tools: agentTools({
				sessionId: "session-1",
				model,
				tools,
				task,
				skills: [],
				mcpTools: snapshot.tools,
				mcp: registry,
				admit,
				context: contextManager,
				contextOptions: () => ({
					budget: 8_000,
					target: 6_400,
					overheadTokens: 0,
				}),
				previewLimit: () => 16_000,
			}),
			messages: [],
		},
		prepareNextTurnWithContext: (turn: {
			context: { messages: unknown[]; tools: AgentTool[] };
		}) => ({
			context: { ...turn.context, tools: agent.state.tools },
		}),
		streamFn: scriptedStream([
			[toolCall("tools_load", "call-1", { id: "tool:mcp__echo__shout" })],
			[toolCall("mcp__echo__shout", "call-2", { text: "hello" })],
			[{ type: "text", text: "done" }],
		]),
		toolExecution: "parallel",
	} as never);

	// The tool is not callable before it is loaded.
	expect(agent.state.tools.some((tool) => tool.name.startsWith("mcp__"))).toBe(
		false,
	);

	await agent.prompt({
		role: "user",
		content: [{ type: "text", text: "search please" }],
		timestamp: Date.now(),
	} as never);

	expect(toolResult(agent, "call-1")).toContain("Loaded mcp__echo__shout");
	// The reported failure produced "Tool mcp__echo__shout not found" here.
	expect(toolResult(agent, "call-2")).toBe("HELLO");
}, 30_000);
