import { expect, test } from "bun:test";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEventStream,
	createAssistantMessageEventStream,
	type Model,
	type ToolCall,
} from "@earendil-works/pi-ai";

/**
 * Pi snapshots `state.tools` when a prompt starts and then reuses whatever
 * context `prepareNextTurnWithContext` returns. A tool published mid-run is
 * therefore only callable if that hook re-reads the agent's tool list, which is
 * what `tools_load` depends on to make an MCP tool reachable.
 */

const model = {
	id: "test-model",
	api: "anthropic",
	provider: "test",
	contextWindow: 100_000,
	maxTokens: 1_000,
} as unknown as Model<never>;

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

/** Replays one scripted assistant message per turn. */
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

function call(name: string, id: string): ToolCall {
	return { type: "toolCall", id, name, arguments: {} };
}

function textTool(name: string, text: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} } as never,
		execute: async () => ({ content: [{ type: "text", text }], details: {} }),
	};
}

/**
 * Mirrors the wiring in `HarnezAgentRuntime.createAgent`: a tool that publishes
 * another tool part-way through a run, and a `prepareNextTurnWithContext` that
 * hands the loop its next context.
 */
function runAgent(refreshTools: boolean) {
	const late = textTool("late_tool", "late output");
	const loader: AgentTool = {
		...textTool("loader", "loaded"),
		execute: async () => {
			agent.state.tools = [...agent.state.tools, late];
			return {
				content: [{ type: "text" as const, text: "loaded" }],
				details: {},
				addedToolNames: [late.name],
			};
		},
	};
	const agent: Agent = new Agent({
		initialState: {
			model,
			thinkingLevel: "off",
			systemPrompt: "test",
			tools: [loader],
			messages: [],
		},
		prepareNextTurnWithContext: (turn: {
			context: { messages: unknown[]; tools: AgentTool[] };
		}) => ({
			context: {
				...turn.context,
				messages: turn.context.messages,
				...(refreshTools ? { tools: agent.state.tools } : {}),
			},
		}),
		streamFn: scriptedStream([
			[call("loader", "call-1")],
			[call("late_tool", "call-2")],
			[{ type: "text", text: "done" }],
		]),
		toolExecution: "parallel",
	} as never);
	return agent;
}

async function resultFor(agent: Agent, toolCallId: string): Promise<string> {
	await agent.prompt({
		role: "user",
		content: [{ type: "text", text: "go" }],
		timestamp: Date.now(),
	} as never);
	const result = agent.state.messages.find(
		(message) =>
			(message as { role?: string; toolCallId?: string }).role === "toolResult" &&
			(message as { toolCallId?: string }).toolCallId === toolCallId,
	) as { content?: { type: string; text?: string }[] } | undefined;
	return (result?.content ?? [])
		.map((part) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("");
}

test("a tool published mid-run is not callable while the context keeps its original tool list", async () => {
	// Reproduces the reported failure: tools_load reports success, then the very
	// next turn cannot reach the tool it just published.
	const output = await resultFor(runAgent(false), "call-2");
	expect(output).toContain("not found");
});

test("refreshing the next turn's tools makes a published tool callable", async () => {
	const output = await resultFor(runAgent(true), "call-2");
	expect(output).toBe("late output");
});
