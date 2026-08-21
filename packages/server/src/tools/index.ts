import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { ToolCapabilityInput } from "../capabilities/types";
import { BashTool } from "./bash";
import { EditTool } from "./edit";
import { ReadTool } from "./read";
import type { ToolContextMetadata, WorkspaceTool } from "./tool";
import { WriteTool } from "./write";

export class CoreTools {
	private readonly tools: WorkspaceTool[];

	constructor(workspace: string, allowedNames?: ReadonlySet<string>) {
		this.tools = [
			new ReadTool(workspace),
			new WriteTool(workspace),
			new EditTool(workspace),
			new BashTool(workspace),
		].filter((tool) => !allowedNames || allowedNames.has(tool.name));
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
			metadataTrust: "harnez",
			providerBinding: { providerId: "workspace", bindingGeneration },
			schema: tool.schema,
			effect: tool.effect,
			modelDiscoverable: false,
		}));
	}

	contextMetadata(name: string): ToolContextMetadata {
		const tool = this.tools.find((candidate) => candidate.name === name);
		return {
			toolName: name,
			evictionPriority: tool?.evictionPriority ?? "normal",
		};
	}
}
