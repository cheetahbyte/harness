import { expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";

import { agentTools } from "../src/agent/tools";
import { CapabilityCatalog } from "../src/capabilities/catalog";
import { CapabilityContext } from "../src/capabilities/context";
import type { ContextManager } from "../src/context/manager";
import { mcpCapabilities } from "../src/mcp/capabilities";
import type { McpToolDescriptor } from "../src/mcp/registry";
import { TaskRuntime } from "../src/task-runtime";
import { CoreTools } from "../src/tools";

const GENERATION = "binding-1";

const descriptor: McpToolDescriptor = {
	server: "echo",
	tool: "shout",
	name: "mcp__echo__shout",
	description: "Shouts the given text.",
	inputSchema: { type: "object", properties: { text: { type: "string" } } },
	readOnly: false,
};

/** Only the members the tools under test touch; nothing here reaches a model. */
const model = { id: "test-model" } as Model<Api>;
const context = {
	recordObservation: () => ({ id: "observation-1" }),
} as unknown as ContextManager;

function harness(calls: string[] = []) {
	const tools = new CoreTools(process.cwd());
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
	const admitted: AgentTool[] = [];
	const list = agentTools({
		sessionId: "session-1",
		model,
		tools,
		task,
		skills: [],
		mcpTools: [descriptor],
		mcp: {
			call: async (server, tool) => {
				calls.push(`${server}/${tool}`);
				return "SHOUTED";
			},
		},
		admit: (tool) => admitted.push(tool),
		context,
		contextOptions: () => ({ budget: 8_000, target: 6_400, overheadTokens: 0 }),
		previewLimit: () => 16_000,
	});
	return { task, list, admitted };
}

function toolNamed(list: AgentTool[], name: string): AgentTool {
	const tool = list.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`missing tool: ${name}`);
	return tool;
}

test("keeps MCP tools out of the model's tool list until they are loaded", () => {
	const { list } = harness();
	const names = list.map((tool) => tool.name);

	expect(names).toContain("read");
	expect(names).toContain("tools_load");
	// The catalog knows about it; the request payload does not.
	expect(names.some((name) => name.startsWith("mcp__"))).toBe(false);
});

test("publishes an MCP tool to the agent when tools_load admits it", async () => {
	const calls: string[] = [];
	const { list, admitted } = harness(calls);

	const result = await toolNamed(list, "tools_load").execute(
		"call-1",
		{ id: "tool:mcp__echo__shout" },
		new AbortController().signal,
	);

	expect(result.addedToolNames).toEqual(["mcp__echo__shout"]);
	expect(admitted.map((tool) => tool.name)).toEqual(["mcp__echo__shout"]);

	// The published tool must actually reach the server through the registry.
	const output = await admitted[0]?.execute(
		"call-2",
		{ text: "hello" },
		new AbortController().signal,
	);
	expect(calls).toEqual(["echo/shout"]);
	expect(output?.content[0]).toMatchObject({ type: "text", text: "SHOUTED" });
});

test("loading a core tool admits its contract without republishing it", async () => {
	const { list, admitted } = harness();

	const result = await toolNamed(list, "tools_load").execute(
		"call-1",
		{ id: "tool:read" },
		new AbortController().signal,
	);

	expect(result.addedToolNames).toEqual(["read"]);
	// `read` is already in the list; admitting it again would duplicate it.
	expect(admitted).toEqual([]);
});

test("refuses to execute an MCP tool that was never loaded", async () => {
	const calls: string[] = [];
	const { list, admitted } = harness(calls);
	await toolNamed(list, "tools_load").execute(
		"call-1",
		{ id: "tool:mcp__echo__shout" },
		new AbortController().signal,
	);
	const published = admitted[0];
	if (!published) throw new Error("nothing was admitted");

	// A second task never loaded this capability, so the runtime must refuse it.
	const { task } = harness();
	await expect(
		task.execute(
			task.snapshot.reference("tool:mcp__echo__shout"),
			{},
			{ execute: async () => "unreachable" },
		),
	).rejects.toThrow("CAPABILITY_NOT_LOADED");
	expect(calls).toEqual([]);
	expect(published.name).toBe("mcp__echo__shout");
});
