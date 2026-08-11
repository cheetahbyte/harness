import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Api, type Model, Type } from "@earendil-works/pi-ai";
import type { TokenAccountant } from "../capabilities/context";
import type { ContextManager } from "../context/manager";
import { activateSkill, type SkillSnapshotEntry } from "../skills";
import type { TaskRuntime } from "../task-runtime";
import { tokenCost } from "../token-cost";
import type { CoreTools } from "../tools";

const RECALL_DESCRIPTION =
	"Read an exact slice from an archived observation:// reference.";
const PIN_DESCRIPTION = "Keep a short instruction for the current task.";
const EPISODE_DESCRIPTION =
	"Start or end one semantic work episode. Actions depend on completed exploration IDs.";

export const TOOL_OVERHEAD_TOKENS = tokenCost({
	tools: [
		...(["read", "write", "edit", "bash"] as const).map((name) => ({
			name,
			description: toolDescription(name),
			parameters: toolSchema(name),
		})),
		{
			name: "recall_observation",
			description: RECALL_DESCRIPTION,
			parameters: recallSchema(),
		},
		{
			name: "pin_context",
			description: PIN_DESCRIPTION,
			parameters: pinSchema(),
		},
		{
			name: "episode",
			description: EPISODE_DESCRIPTION,
			parameters: episodeSchema(),
		},
	],
});

type AgentToolsOptions = {
	sessionId: string;
	model: Model<Api>;
	tools: CoreTools;
	task: TaskRuntime;
	skills: readonly SkillSnapshotEntry[];
	context: ContextManager;
	contextOptions: (model: Model<Api>) => {
		budget: number;
		target: number;
		overheadTokens: number;
	};
	previewLimit: (model: Model<Api>) => number;
};

export function agentTools(options: AgentToolsOptions): AgentTool[] {
	return [
		...capabilityTools(options.task, options.model, options.skills),
		...coreTools(options),
		...contextTools(options),
	];
}

function coreTools({
	sessionId,
	model,
	tools,
	task,
	context,
	previewLimit,
}: AgentToolsOptions): AgentTool[] {
	return tools.agentTools().map(
		(tool): AgentTool => ({
			...tool,
			execute: async (id, input, signal, onUpdate) => {
				const ref = task.snapshot.reference(`tool:${tool.name}`);
				const result = (await task.execute(ref, input, {
					execute: async (_input, runtimeSignal) =>
						await tool.execute(
							id,
							input,
							combinedSignal(signal, runtimeSignal),
							onUpdate,
						),
				})) as Awaited<ReturnType<typeof tool.execute>>;
				if (signal?.aborted || task.state !== "running")
					throw new DOMException("Aborted", "AbortError");
				const output = result.content
					.map((content: { type: string; text?: string }) => content.text ?? "")
					.join("");
				const observation = context.recordObservation(sessionId, output, {
					toolCallId: id,
					...tools.contextMetadata(tool.name),
				});
				return {
					...result,
					content: [
						{
							type: "text" as const,
							text: previewOutput(output, observation.id, previewLimit(model)),
						},
					],
					details: {
						...detailsRecord(result.details),
						observationId: observation.id,
					},
				};
			},
		}),
	);
}

function contextTools({
	sessionId,
	model,
	context,
	contextOptions,
}: AgentToolsOptions): AgentTool[] {
	return [
		recallTool(sessionId, context),
		pinTool(sessionId, model, context, contextOptions),
		episodeTool(sessionId, context),
	];
}

function capabilityTools(
	task: TaskRuntime,
	model: Model<Api>,
	skills: readonly SkillSnapshotEntry[],
): AgentTool[] {
	const accountant: TokenAccountant = {
		modelId: model.id,
		serializerVersion: "pi-json-v1",
		method: "conservative_estimate",
		count: (request) => tokenCost(request),
	};
	return [
		listCapabilitiesTool(task),
		searchCapabilitiesTool(task),
		inspectCapabilityTool(task),
		loadTool(task, accountant),
		activateSkillTool(task, skills, accountant),
	];
}

function listCapabilitiesTool(task: TaskRuntime): AgentTool {
	return {
		name: "capabilities_list",
		label: "list capabilities",
		description: "List permitted capabilities with bounded pagination.",
		parameters: capabilityListSchema(),
		execute: async (_id, input) => ({
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(task.snapshot.list(input as never)),
				},
			],
			details: {},
		}),
	};
}
function searchCapabilitiesTool(task: TaskRuntime): AgentTool {
	return {
		name: "capabilities_search",
		label: "search capabilities",
		description: "Search permitted capability metadata lexically.",
		parameters: capabilitySearchSchema(),
		execute: async (_id, input) => {
			const { query, ...options } = input as {
				query: string;
				kind?: "tool" | "skill";
				limit?: number;
				cursor?: string;
			};
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(task.snapshot.search(query, options)),
					},
				],
				details: {},
			};
		},
	};
}
function inspectCapabilityTool(task: TaskRuntime): AgentTool {
	return {
		name: "capabilities_inspect",
		label: "inspect capability",
		description: "Inspect one capability contract by canonical id.",
		parameters: idSchema(),
		execute: async (_id, input) => {
			const ref = task.snapshot.reference((input as { id: string }).id);
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(task.snapshot.inspect(ref)),
					},
				],
				details: { ref },
			};
		},
	};
}
function loadTool(task: TaskRuntime, accountant: TokenAccountant): AgentTool {
	return {
		name: "tools_load",
		label: "load tool",
		description: "Admit one inspected tool schema into task context.",
		parameters: idSchema(),
		execute: async (_id, input) => {
			const ref = task.snapshot.reference((input as { id: string }).id);
			task.snapshot.require(ref, "load");
			const inspected = task.snapshot.inspect(ref);
			if (inspected.kind !== "tool") throw new Error("CAPABILITY_NOT_A_TOOL");
			const admission = task.context.admit({
				capability: ref,
				scope: "task",
				contentHash: ref.contractHash,
				content: inspected.contract,
				accountant,
			});
			if (admission.status === "rejected")
				throw new Error(JSON.stringify(admission));
			task.load(ref);
			return {
				content: [{ type: "text" as const, text: `Loaded ${inspected.name}` }],
				details: { contextItemId: admission.item?.id },
				addedToolNames: [inspected.name],
			};
		},
	};
}
function activateSkillTool(
	task: TaskRuntime,
	skills: readonly SkillSnapshotEntry[],
	accountant: TokenAccountant,
): AgentTool {
	return {
		name: "skills_activate",
		label: "activate skill",
		description: "Verify and activate one skill for this task.",
		parameters: idSchema(),
		execute: async (_id, input) => {
			const ref = task.snapshot.reference((input as { id: string }).id);
			task.snapshot.require(ref, "activate");
			const entry = skills.find((candidate) => candidate.ref.id === ref.id);
			if (!entry) throw new Error("STALE_CAPABILITY");
			const admission = await activateSkill(
				entry,
				ref,
				task.context,
				accountant,
			);
			if (admission.status === "rejected")
				throw new Error(JSON.stringify(admission));
			return {
				content: [
					{ type: "text" as const, text: `Activated ${entry.capability.name}` },
				],
				details: { contextItemId: admission.item?.id },
			};
		},
	};
}

function combinedSignal(
	providerSignal: AbortSignal | undefined,
	runtimeSignal: AbortSignal,
): AbortSignal {
	return providerSignal
		? AbortSignal.any([providerSignal, runtimeSignal])
		: runtimeSignal;
}
function recallTool(sessionId: string, context: ContextManager): AgentTool {
	return {
		name: "recall_observation",
		label: "recall observation",
		description: RECALL_DESCRIPTION,
		parameters: recallSchema(),
		execute: async (_id, input) => {
			const result = context.recall(
				sessionId,
				(input as { reference: string }).reference,
			);
			return {
				content: [{ type: "text", text: result.text }],
				details: result,
			};
		},
	};
}
function pinTool(
	sessionId: string,
	model: Model<Api>,
	context: ContextManager,
	contextOptions: AgentToolsOptions["contextOptions"],
): AgentTool {
	return {
		name: "pin_context",
		label: "pin context",
		description: PIN_DESCRIPTION,
		parameters: pinSchema(),
		execute: async (_id, input) => {
			const { kind, text } = input as {
				kind: "decision" | "constraint";
				text: string;
			};
			const item = context.pin(sessionId, kind, text, contextOptions(model));
			return {
				content: [{ type: "text", text: `Pinned context: ${item.id}` }],
				details: { id: item.id },
			};
		},
	};
}
function episodeTool(sessionId: string, context: ContextManager): AgentTool {
	return {
		name: "episode",
		label: "episode",
		description: EPISODE_DESCRIPTION,
		parameters: episodeSchema(),
		execute: async (_id, input) => {
			const request = input as EpisodeInput;
			const episode =
				request.action === "start"
					? context.startEpisode(sessionId, request)
					: context.endEpisode(sessionId, request.conclusion);
			return {
				content: [
					{
						type: "text" as const,
						text: `${episode.state} ${episode.kind} episode ${episode.name} (${episode.id})`,
					},
				],
				details: episode,
			};
		},
	};
}
type CoreToolName = "read" | "write" | "edit" | "bash";
function toolDescription(name: CoreToolName): string {
	return {
		read: "Read a text file in the workspace.",
		write: "Write a text file in the workspace.",
		edit: "Replace exact text in a file.",
		bash: "Run a shell command in the workspace.",
	}[name];
}
function toolSchema(name: CoreToolName) {
	const path = Type.String({ minLength: 1 });
	return name === "read"
		? Type.Object({ path })
		: name === "write"
			? Type.Object({ path, content: Type.String() })
			: name === "edit"
				? Type.Object({ path, oldText: Type.String(), newText: Type.String() })
				: Type.Object({ command: Type.String({ minLength: 1 }) });
}
function recallSchema() {
	return Type.Object({ reference: Type.String({ minLength: 1 }) });
}
function idSchema() {
	return Type.Object({ id: Type.String({ minLength: 1 }) });
}
function capabilityListSchema() {
	return Type.Object({
		kind: Type.Optional(
			Type.Union([Type.Literal("tool"), Type.Literal("skill")]),
		),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
		cursor: Type.Optional(Type.String()),
	});
}
function capabilitySearchSchema() {
	return Type.Object({
		query: Type.String({ minLength: 1 }),
		kind: Type.Optional(
			Type.Union([Type.Literal("tool"), Type.Literal("skill")]),
		),
		limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
		cursor: Type.Optional(Type.String()),
	});
}
function pinSchema() {
	return Type.Object({
		kind: Type.Union([Type.Literal("decision"), Type.Literal("constraint")]),
		text: Type.String({ minLength: 1 }),
	});
}
type EpisodeInput =
	| {
			action: "start";
			name: string;
			kind: "exploration" | "action";
			dependencies?: string[];
	  }
	| { action: "end"; conclusion?: string };
function episodeSchema() {
	return Type.Union([
		Type.Object({
			action: Type.Literal("start"),
			name: Type.String({ minLength: 1 }),
			kind: Type.Union([Type.Literal("exploration"), Type.Literal("action")]),
			dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		}),
		Type.Object({
			action: Type.Literal("end"),
			conclusion: Type.Optional(Type.String({ minLength: 1 })),
		}),
	]);
}
function previewOutput(output: string, id: string, limit: number): string {
	if (output.length <= limit) return output;
	const marker = `\n\n[output truncated; full output: observation://${id}]\n\n`;
	const visible = Math.max(0, limit - marker.length);
	const head = Math.ceil(visible / 2);
	return `${output.slice(0, head)}${marker}${output.slice(output.length - (visible - head))}`;
}
function detailsRecord(details: unknown): Record<string, unknown> {
	return typeof details === "object" &&
		details !== null &&
		!Array.isArray(details)
		? (details as Record<string, unknown>)
		: {};
}
