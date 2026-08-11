import type { AgentTool } from "@earendil-works/pi-agent-core";
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
