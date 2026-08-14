import { relative, resolve } from "node:path";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { TSchema } from "@earendil-works/pi-ai";

import type { EffectClass } from "../capabilities/types";

const writeLocks = new Map<string, Promise<void>>();

export const EvictionPriority = {
	Early: "early",
	Normal: "normal",
	Late: "late",
} as const;

export type EvictionPriority =
	(typeof EvictionPriority)[keyof typeof EvictionPriority];

export type ToolContextMetadata = {
	toolName: string;
	evictionPriority: EvictionPriority;
};

export abstract class WorkspaceTool {
	abstract readonly name: string;
	abstract readonly description: string;
	abstract readonly schema: TSchema;
	readonly evictionPriority: EvictionPriority = EvictionPriority.Normal;
	readonly effect: EffectClass = "mutating";

	constructor(protected readonly workspace: string) {}

	protected path(value: unknown): string {
		if (typeof value !== "string" || !value)
			throw new Error("path must be a non-empty string");
		const absolute = resolve(this.workspace, value);
		if (relative(this.workspace, absolute).startsWith(".."))
			throw new Error("path escapes workspace");
		return absolute;
	}

	protected async withWriteLock<T>(
		path: string,
		operation: () => Promise<T>,
	): Promise<T> {
		const previous = writeLocks.get(path) ?? Promise.resolve();
		let release!: () => void;
		const current = new Promise<void>((releaseLock) => {
			release = releaseLock;
		});
		writeLocks.set(path, current);
		await previous;
		try {
			return await operation();
		} finally {
			release();
			if (writeLocks.get(path) === current) writeLocks.delete(path);
		}
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
