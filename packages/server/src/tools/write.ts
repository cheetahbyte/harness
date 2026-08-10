import { writeFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { WorkspaceTool } from "./tool";

export class WriteTool extends WorkspaceTool {
	readonly name = "write";
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
		await writeFile(this.path(input["path"]), input["content"]);
		return `wrote ${input["path"]}`;
	}
}
