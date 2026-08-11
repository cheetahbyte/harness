import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { CapabilityRef, ToolCapabilityInput } from "../capability-control";
import { BashTool } from "./bash";
import { EditTool } from "./edit";
import { ReadTool } from "./read";
import type { ToolContextMetadata, WorkspaceTool } from "./tool";
import { WriteTool } from "./write";

export class CoreTools {
	private readonly tools: WorkspaceTool[];

	constructor(workspace: string) {
		this.tools = [
			new ReadTool(workspace),
			new WriteTool(workspace),
			new EditTool(workspace),
			new BashTool(workspace),
		];
	}

	agentTools(): AgentTool[] {
		return this.tools.map((tool) => tool.agentTool());
	}

	capabilities(bindingGeneration: string): ToolCapabilityInput[] {
		return this.tools.map((tool) => ({
			kind: "tool",
			id: `tool:${tool.name}`,
			name: tool.name,
			description: tool.description,
			providerDisplayName: "Workspace",
			metadataTrust: "harness",
			providerBinding: { providerId: "workspace", bindingGeneration },
			schema: tool.schema,
			effect: tool.effect,
		}));
	}

	agentTool(name: string): AgentTool {
		const tool = this.tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`unknown tool: ${name}`);
		return tool.agentTool();
	}

	nameForRef(ref: CapabilityRef): string {
		const name = ref.id.startsWith("tool:") ? ref.id.slice(5) : "";
		if (!this.tools.some((tool) => tool.name === name))
			throw new Error("STALE_CAPABILITY");
		return name;
	}

	contextMetadata(name: string): ToolContextMetadata {
		const tool = this.tools.find((candidate) => candidate.name === name);
		return {
			toolName: name,
			evictionPriority: tool?.evictionPriority ?? "normal",
		};
	}

	async execute(
		name: string,
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string> {
		const tool = this.tools.find((candidate) => candidate.name === name);
		if (!tool) throw new Error(`unknown tool: ${name}`);
		return await tool.execute(input, signal);
	}
}
