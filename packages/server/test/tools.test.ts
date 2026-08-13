import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreTools } from "../src/tools";

async function execute(
	tools: CoreTools,
	name: string,
	input: Record<string, unknown>,
	signal: AbortSignal,
): Promise<string> {
	const tool = tools.agentTools().find((tool) => tool.name === name);
	if (!tool) throw new Error(`unknown tool: ${name}`);
	let result: Awaited<ReturnType<typeof tool.execute>>;
	try {
		result = await tool.execute("test", input, signal);
	} catch (error) {
		throw new Error(
			`tool.execute failed for ${name} with ${JSON.stringify(input)}: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	return result.content
		.flatMap((content) => (content.type === "text" ? [content.text] : []))
		.join("");
}

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("registers class-backed tools and runs their file operations", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "harnez-tools-"));
	paths.push(workspace);
	const tools = new CoreTools(workspace);
	const signal = new AbortController().signal;

	expect(tools.agentTools().map((tool) => tool.name)).toEqual([
		"read",
		"write",
		"edit",
		"bash",
	]);
	expect(tools.contextMetadata("write")).toEqual({
		toolName: "write",
		evictionPriority: "early",
	});
	await execute(tools, "write", { path: "note.txt", content: "before" }, signal);
	await execute(
		tools,
		"edit",
		{ path: "note.txt", oldText: "before", newText: "after" },
		signal,
	);
	expect(await execute(tools, "read", { path: "note.txt" }, signal)).toBe("after");
	writeFileSync(join(workspace, "twice.txt"), "x x");
	await expect(
		execute(
			tools,
			"edit",
			{ path: "twice.txt", oldText: "x", newText: "y" },
			signal,
		),
	).rejects.toThrow("oldText must occur exactly once");
	expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe("after");
});

test("serializes concurrent edits to the same file", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "harnez-tools-"));
	paths.push(workspace);
	const signal = new AbortController().signal;
	const source = Array.from({ length: 20 }, (_, index) => `item-${index};`).join("");
	writeFileSync(join(workspace, "note.txt"), source);

	await Promise.all(
		Array.from({ length: 20 }, (_, index) =>
			execute(
				new CoreTools(workspace),
				"edit",
				{ path: "note.txt", oldText: `item-${index};`, newText: `done-${index};` },
				signal,
			),
		),
	);

	expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe(
		Array.from({ length: 20 }, (_, index) => `done-${index};`).join(""),
	);
});
