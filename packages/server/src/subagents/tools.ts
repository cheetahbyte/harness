import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";

import type { ToolCapabilityInput } from "../capabilities/types";
import type { SubagentResult } from "../context/types";
import type { SubagentManager } from "./manager";

const resultSchema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("completed"),
			Type.Literal("blocked"),
			Type.Literal("failed"),
		]),
		summary: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const text = (value: unknown) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
	details: {},
});

export function parentSubagentCapabilities(
	tools: readonly AgentTool[],
	bindingGeneration: string,
): ToolCapabilityInput[] {
	return tools.map(({ name, description, parameters }) => ({
		kind: "tool",
		id: `tool:${name}`,
		name,
		description,
		providerDisplayName: "Harnez subagents",
		metadataTrust: "harnez",
		providerBinding: { providerId: "harnez-subagents", bindingGeneration },
		schema: parameters,
		effect: name === "get_agent_result" ? "read_only" : "mutating",
	}));
}

export function parentSubagentTools(
	manager: SubagentManager,
	sessionId: string,
): AgentTool[] {
	return [
		{
			name: "spawn_agent",
			label: "Spawn agent",
			description: "Start an isolated subagent for a bounded task.",
			parameters: Type.Object(
				{
					profile: Type.String({ minLength: 1 }),
					task: Type.String({ minLength: 1 }),
					description: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
			execute: async (_id, input) =>
				text(
					await manager.spawn({
						sessionId,
						...(input as {
							profile: string;
							task: string;
							description: string;
						}),
					}),
				),
		},
		{
			name: "get_agent_result",
			label: "Get agent result",
			description: "Read a subagent state or wait for its handoff.",
			parameters: Type.Object(
				{
					id: Type.String({ minLength: 1 }),
					wait: Type.Optional(Type.Boolean()),
				},
				{ additionalProperties: false },
			),
			execute: async (_id, input, signal) => {
				const request = input as { id: string; wait?: boolean };
				return text(
					await manager.get(sessionId, request.id, {
						...(request.wait === undefined ? {} : { wait: request.wait }),
						...(signal ? { signal } : {}),
					}),
				);
			},
		},
		{
			name: "steer_agent",
			label: "Steer agent",
			description: "Replace a running subagent's pending direction.",
			parameters: Type.Object(
				{
					id: Type.String({ minLength: 1 }),
					message: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
			execute: async (_id, input) => {
				const request = input as { id: string; message: string };
				return text(manager.steer(sessionId, request.id, request.message));
			},
		},
		{
			name: "cancel_agent",
			label: "Cancel agent",
			description: "Cancel a running subagent.",
			parameters: Type.Object(
				{ id: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
			execute: async (_id, input) =>
				text(await manager.cancel(sessionId, (input as { id: string }).id)),
		},
		{
			name: "resume_agent",
			label: "Resume agent",
			description:
				"Resume a terminal subagent conversation with a new message.",
			parameters: Type.Object(
				{
					id: Type.String({ minLength: 1 }),
					message: Type.String({ minLength: 1 }),
				},
				{ additionalProperties: false },
			),
			execute: async (_id, input) => {
				const request = input as { id: string; message: string };
				return text(
					await manager.resume(sessionId, request.id, request.message),
				);
			},
		},
	];
}

export function submitSubagentResultTool(
	submit: (result: SubagentResult) => boolean,
): AgentTool {
	return {
		name: "submit_subagent_result",
		label: "Submit subagent result",
		description:
			"Submit a status and Markdown handoff exactly once before ending.",
		parameters: resultSchema,
		execute: async (_id, input) =>
			text({ accepted: submit(input as SubagentResult) }),
	};
}
