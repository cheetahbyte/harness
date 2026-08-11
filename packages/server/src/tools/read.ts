import { readFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { WorkspaceTool } from "./tool";

export class ReadTool extends WorkspaceTool {
	readonly name = "read";
	readonly description = "Read a text file in the workspace.";
	readonly schema = Type.Object({ path: Type.String({ minLength: 1 }) });

	async execute(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string> {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		return await readFile(this.path(input["path"]), "utf8");
	}
}
