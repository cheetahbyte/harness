import { writeFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { WorkspaceTool } from "./tool";

export class WriteTool extends WorkspaceTool {
	readonly name = "write";
	override readonly evictionPriority = "early" as const;
	readonly description = "Write a text file in the workspace.";
	readonly schema = Type.Object({
		path: Type.String({ minLength: 1 }),
		content: Type.String(),
	});

	async execute(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string> {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		if (typeof input["content"] !== "string")
			throw new Error("content must be a string");
		const content = input["content"];
		const path = this.path(input["path"]);
		await this.withWriteLock(path, async () => {
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			await writeFile(path, content);
		});
		return `wrote ${input["path"]}`;
	}
}
