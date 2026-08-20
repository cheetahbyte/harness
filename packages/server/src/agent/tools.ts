import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type Model,
	type TSchema,
	Type,
} from "@earendil-works/pi-ai";

import {
	describeRejection,
	type TokenAccountant,
} from "../capabilities/context";
import type {
	EffectClass,
	InspectedCapability,
	ToolCapabilityInput,
} from "../capabilities/types";
import { validateCondensationInput } from "../context/condensation";
import type { ContextManager } from "../context/manager";
import {
	MAX_OBSERVATION_RECALL_LIMIT,
	parseObservationUri,
} from "../context/recall";
import type { ObservationRecall } from "../context/types";
import type { McpRegistry, McpToolDescriptor } from "../mcp/registry";
import { activateSkill, type SkillSnapshotEntry } from "../skills";
import type { TaskRuntime } from "../task-runtime";
import { tokenCost } from "../token-cost";
import { CoreTools } from "../tools";
import { EvictionPriority, type ToolContextMetadata } from "../tools/tool";
import { detailsRecord } from "./message";

const RECALL_DESCRIPTION =
	"Read an exact slice from an archived observation:// reference. Pages with offset and limit; the reply states its range when it is partial.";
const PIN_DESCRIPTION =
	"Keep a short instruction for long-running work that risks context compaction. Skip it for short tasks.";
const EPISODE_DESCRIPTION =
	"Start or end one semantic work episode for long-running work that risks context compaction. Skip it for short tasks. Actions depend on completed exploration IDs. Exploration end requires a conclusion; action end must omit it.";
const CONDENSE_DESCRIPTION =
	"Replace completed historical work with a bounded structured memory. Use after a completed subtask, strategy change, or repeated failure recovery; skip short tasks and active episodes.";

/**
 * The context tools every turn carries, described once so the token estimate,
 * the tool definitions, and the capability catalog cannot drift apart.
 */
const CONTEXT_TOOLS = [
	{
		name: "recall_observation",
		description: RECALL_DESCRIPTION,
		parameters: recallSchema(),
		effect: "read_only",
	},
	{
		name: "pin_context",
		description: PIN_DESCRIPTION,
		parameters: pinSchema(),
		effect: "mutating",
	},
	{
		name: "episode",
		description: EPISODE_DESCRIPTION,
		parameters: episodeSchema(),
		effect: "mutating",
	},
	{
		name: "condense_context",
		description: CONDENSE_DESCRIPTION,
		parameters: condensationSchema(),
		effect: "mutating",
	},
] as const satisfies readonly {
	name: string;
	description: string;
	parameters: unknown;
	effect: EffectClass;
}[];

export const TOOL_OVERHEAD_TOKENS = tokenCost({
	tools: [
		...new CoreTools("")
			.agentTools()
			.map(({ name, description, parameters }) => ({
				name,
				description,
				parameters,
			})),
		...CONTEXT_TOOLS.map(({ name, description, parameters }) => ({
			name,
			description,
			parameters,
		})),
	],
});

/**
 * Catalog entries for the context tools. They are always in the model's tool
 * list, but discovery answers from the catalog alone: omitting them let a model
 * inspect its own capabilities, conclude it had no way to reach an archived
 * observation, and reach for the session database by hand instead.
 */
export function contextCapabilities(
	bindingGeneration: string,
): ToolCapabilityInput[] {
	return CONTEXT_TOOLS.map((tool) => ({
		kind: "tool",
		id: `tool:${tool.name}`,
		name: tool.name,
		description: tool.description,
		providerDisplayName: "Harnez context",
		metadataTrust: "harnez",
		providerBinding: { providerId: "harnez", bindingGeneration },
		schema: tool.parameters,
		effect: tool.effect,
	}));
}

type AgentToolsOptions = {
	sessionId: string;
	model: Model<Api>;
	tools: CoreTools;
	task: TaskRuntime;
	skills: readonly SkillSnapshotEntry[];
	context: ContextManager;
	/** Tools advertised by connected MCP servers, admitted on demand. */
	mcpTools: readonly McpToolDescriptor[];
	mcp: Pick<McpRegistry, "call">;
	/**
	 * Publishes a tool to the running agent. Capabilities outside the core set
	 * stay out of the model's tool list until `tools_load` admits them, which is
	 * what keeps a large MCP server from riding along in every request.
	 */
	admit: (tool: AgentTool) => void;
	contextOptions: (model: Model<Api>) => {
		budget: number;
		target: number;
		overheadTokens: number;
	};
	previewLimit: (model: Model<Api>) => number;
	emit?: (event: import("../../../shared/src/protocol").ServerEvent) => void;
};

export function agentTools(options: AgentToolsOptions): AgentTool[] {
	return [
		...capabilityTools(options),
		...coreTools(options),
		...contextTools(options),
	];
}

function coreTools(options: AgentToolsOptions): AgentTool[] {
	return options.tools
		.agentTools()
		.map((tool) =>
			instrument(tool, options, options.tools.contextMetadata(tool.name)),
		);
}

/**
 * Wraps a tool so every call is authorized and ledgered by the task runtime and
 * its output is archived as an observation, leaving only a bounded preview in
 * context. Core and MCP tools share this path so they behave identically.
 */
function instrument(
	tool: AgentTool,
	{ sessionId, model, task, context, previewLimit }: AgentToolsOptions,
	metadata: ToolContextMetadata,
): AgentTool {
	return {
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
				...metadata,
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
	};
}

/**
 * The callable form of an MCP tool. It is built only when `tools_load` admits
 * the capability, so an unloaded server costs nothing but a catalog entry.
 */
function mcpAgentTool(
	descriptor: McpToolDescriptor,
	inspected: InspectedCapability,
	options: AgentToolsOptions,
): AgentTool {
	const tool: AgentTool = {
		name: descriptor.name,
		label: `${descriptor.server}: ${descriptor.tool}`,
		description: inspected.description,
		parameters: (inspected.contract as { schema: TSchema }).schema,
		execute: async (id, input, signal) => ({
			content: [
				{
					type: "text" as const,
					text: await options.mcp.call(
						descriptor.server,
						descriptor.tool,
						input,
						signal ?? new AbortController().signal,
					),
				},
			],
			details: { id },
		}),
	};
	return instrument(tool, options, {
		toolName: descriptor.name,
		// Server output can be anything, so it gets the ordinary eviction rank.
		evictionPriority: EvictionPriority.Normal,
	});
}

function contextTools({
	sessionId,
	model,
	context,
	contextOptions,
	emit,
	task,
}: AgentToolsOptions): AgentTool[] {
	return [
		recallTool(sessionId, context, task),
		pinTool(sessionId, model, context, contextOptions),
		episodeTool(sessionId, context),
		condenseTool(sessionId, model, context, contextOptions, task, emit),
	];
}

function capabilityTools(options: AgentToolsOptions): AgentTool[] {
	const { task, model, skills } = options;
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
		loadTool(options, accountant),
		activateSkillTool(task, skills, accountant),
	];
}

function listCapabilitiesTool(task: TaskRuntime): AgentTool {
	return {
		name: "capabilities_list",
		label: "list capabilities",
		description:
			"List the registry of permitted workspace tools, context tools and skills, with bounded pagination. Discovery tools themselves are always present and are not registry entries.",
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
		description:
			"Search the same registry as capabilities_list lexically. An empty result means nothing in the registry matched, not that the tool is unavailable.",
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
function loadTool(
	options: AgentToolsOptions,
	accountant: TokenAccountant,
): AgentTool {
	const { task, mcpTools, admit } = options;
	return {
		name: "tools_load",
		label: "load tool",
		description:
			"Make one catalog tool callable, using an id from capabilities_search or capabilities_list. Inspecting it first is optional. The tool joins your tool list from the next turn onward, so end the turn after loading it rather than trying to call it in the same one.",
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
				throw new Error(
					describeRejection(admission, `The ${inspected.name} tool`),
				);
			task.load(ref);
			/**
			 * Loading a core tool only admits its contract — it is already callable.
			 * A catalog-only tool has to be published to the agent as well, or the
			 * model would be told it succeeded and still have nothing to call.
			 */
			const descriptor = mcpTools.find((tool) => tool.name === inspected.name);
			if (descriptor) admit(mcpAgentTool(descriptor, inspected, options));
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
				"step",
			);
			if (admission.status === "rejected")
				throw new Error(
					describeRejection(admission, `The ${entry.capability.name} skill`),
				);
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
function recallTool(
	sessionId: string,
	context: ContextManager,
	task: TaskRuntime,
): AgentTool {
	return {
		name: "recall_observation",
		label: "recall observation",
		description: RECALL_DESCRIPTION,
		parameters: recallSchema(),
		execute: async (_id, input) => {
			const { reference, offset, limit } = input as {
				reference: string;
				offset?: number;
				limit?: number;
			};
			/** Explicit arguments win over anything already in the URI's query. */
			const result = context.recall(sessionId, {
				...parseObservationUri(reference),
				...(offset === undefined ? {} : { offset }),
				...(limit === undefined ? {} : { limit }),
			});
			const coverage = task.recordSourceRead(
				result.observationId,
				result.totalLength,
				result.source.previewedRanges ?? [],
				[result.offset, result.offset + result.text.length],
			);
			return {
				content: [
					{
						type: "text",
						text: `${result.text}${extent(result)}\n\n${coverageText(coverage)}`,
					},
				],
				details: { ...result, coverage },
			};
		},
	};
}

function coverageText(
	coverage: import("../task-runtime").SourceCoverage,
): string {
	return [
		`authoritative_source: observation://${coverage.sourceId}`,
		`characters: ${coverage.totalCharacters}`,
		coverageRanges("read_ranges", coverage.readRanges),
		coverageRanges("unread_ranges", coverage.unreadRanges),
	].join("\n");
}

function coverageRanges(
	name: string,
	values: readonly (readonly [number, number])[],
): string {
	return `${name}:\n${values.map(([start, end]) => `  - [${start}, ${end})`).join("\n") || "  - none"}`;
}

/**
 * A slice that stops short of the payload looks exactly like a complete read,
 * so the range is stated whenever it is one. Recalls default to 16k characters
 * and observations are routinely far larger than that.
 */
function extent({ text, offset, totalLength }: ObservationRecall): string {
	const end = offset + text.length;
	if (offset === 0 && end >= totalLength) return "";
	return `\n\n[showing characters ${offset}-${end} of ${totalLength}${end < totalLength ? `; continue with offset=${end}` : ""}]`;
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
			let episode: ReturnType<ContextManager["startEpisode"]>;
			if (request.action === "start") {
				if (request.name === undefined || request.kind === undefined)
					throw new Error("Starting an episode requires name and kind");
				episode = context.startEpisode(sessionId, {
					name: request.name,
					kind: request.kind,
					...(request.dependencies === undefined
						? {}
						: { dependencies: request.dependencies }),
				});
			} else episode = context.endEpisode(sessionId, request.conclusion);
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
function condenseTool(
	sessionId: string,
	model: Model<Api>,
	context: ContextManager,
	contextOptions: AgentToolsOptions["contextOptions"],
	task: TaskRuntime,
	emit: AgentToolsOptions["emit"],
): AgentTool {
	return {
		name: "condense_context",
		label: "condense context",
		description: CONDENSE_DESCRIPTION,
		parameters: condensationSchema(),
		execute: async (_id, input) => {
			const result = context.condense(
				sessionId,
				validateCondensationInput(input),
				{
					...contextOptions(model),
					taskId: task.id,
					...(task.taskStartSequence === undefined
						? {}
						: { currentTaskStartSequence: task.taskStartSequence }),
					predecessorTerminalIds: task.predecessorTerminalMessageIds,
				},
			);
			if (!result.noOp)
				emit?.({
					type: "context-compaction",
					sessionId,
					taskId: task.id,
					...(result.assemblyId === undefined
						? {}
						: { assemblyId: result.assemblyId }),
					trigger: "explicit",
					milestone: result.milestone,
					evictedCount: result.archivedItems,
					tokensBefore: result.tokensBefore,
					tokensAfter: result.tokensAfter,
					episodesArchived: result.archivedEpisodes,
				});
			return {
				content: [
					{
						type: "text" as const,
						text: result.noOp
							? "No context was condensed."
							: `Condensed context at ${result.milestone}: ${result.tokensBefore} → ${result.tokensAfter} tokens`,
					},
				],
				details: result,
			};
		},
	};
}
function recallSchema() {
	return Type.Object({
		reference: Type.String({ minLength: 1 }),
		offset: Type.Optional(Type.Number({ minimum: 0 })),
		limit: Type.Optional(
			Type.Number({ minimum: 1, maximum: MAX_OBSERVATION_RECALL_LIMIT }),
		),
	});
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
type EpisodeInput = {
	action: "start" | "end";
	name?: string;
	kind?: "exploration" | "action";
	dependencies?: string[];
	conclusion?: string;
};
function episodeSchema() {
	return Type.Object(
		{
			action: Type.String({ enum: ["start", "end"] }),
			name: Type.Optional(Type.String({ minLength: 1 })),
			kind: Type.Optional(Type.String({ enum: ["exploration", "action"] })),
			dependencies: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
			conclusion: Type.Optional(
				Type.String({
					minLength: 1,
					description:
						"Required when ending exploration; omit when ending action.",
				}),
			),
		},
		{ additionalProperties: false },
	);
}
function condensationSchema() {
	const entry = Type.String({ minLength: 1, maxLength: 1_000 });
	return Type.Object(
		{
			milestone: Type.String({ minLength: 1, maxLength: 200 }),
			completedWork: Type.Array(entry, { maxItems: 20 }),
			strategies: Type.Array(Type.Object({ approach: entry, outcome: entry }), {
				maxItems: 20,
			}),
			environmentChanges: Type.Array(entry, { maxItems: 20 }),
			constraints: Type.Array(entry, { maxItems: 20 }),
			openQuestions: Type.Array(entry, { maxItems: 20 }),
			references: Type.Array(entry, { maxItems: 20 }),
		},
		{ additionalProperties: false },
	);
}
function previewOutput(output: string, id: string, limit: number): string {
	if (output.length <= limit) return output;
	const marker = `\n\n[output truncated; full output: observation://${id}]\n\n`;
	const visible = Math.max(0, limit - marker.length);
	const head = Math.ceil(visible / 2);
	return `${output.slice(0, head)}${marker}${output.slice(output.length - (visible - head))}`;
}
