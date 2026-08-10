import { readFile, writeFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import { WorkspaceTool } from "./tool";

export class EditTool extends WorkspaceTool {
	readonly name = "edit";
	readonly description = "Replace exact text in a file.";
	readonly schema = Type.Object({
		path: Type.String({ minLength: 1 }),
		oldText: Type.String(),
		newText: Type.String(),
	});

	async execute(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string> {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		if (
			typeof input["oldText"] !== "string" ||
			typeof input["newText"] !== "string"
		)
			throw new Error("oldText and newText must be strings");
		const path = this.path(input["path"]);
		const source = await readFile(path, "utf8");
		const count = source.split(input["oldText"]).length - 1;
		if (count !== 1)
			throw new Error(`oldText must occur exactly once (found ${count})`);
		await writeFile(path, source.replace(input["oldText"], input["newText"]));
		return `edited ${input["path"]}`;
	}
}
