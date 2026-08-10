import { relative, resolve } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

export abstract class WorkspaceTool {
	abstract readonly name: string;
	abstract readonly description: string;
	abstract readonly schema: TSchema;

	constructor(protected readonly workspace: string) {}

	protected path(value: unknown): string {
		if (typeof value !== "string" || !value)
			throw new Error("path must be a non-empty string");
		const absolute = resolve(this.workspace, value);
		if (relative(this.workspace, absolute).startsWith(".."))
			throw new Error("path escapes workspace");
		return absolute;
	}

	abstract execute(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string>;

	agentTool(): AgentTool {
		return {
			name: this.name,
			label: this.name,
			description: this.description,
			parameters: this.schema,
			execute: async (id, input, signal) => ({
				content: [
					{
						type: "text",
						text: await this.execute(
							input as Record<string, unknown>,
							signal ?? new AbortController().signal,
						),
					},
				],
				details: { id },
			}),
		};
	}
}
