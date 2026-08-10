import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreTools } from "../src/tools";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("registers class-backed tools and runs their file operations", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "harness-tools-"));
	paths.push(workspace);
	const tools = new CoreTools(workspace);
	const signal = new AbortController().signal;

	expect(tools.agentTools().map((tool) => tool.name)).toEqual([
		"read",
		"write",
		"edit",
		"bash",
	]);
	await tools.execute("write", { path: "note.txt", content: "before" }, signal);
	await tools.execute(
		"edit",
		{ path: "note.txt", oldText: "before", newText: "after" },
		signal,
	);
	expect(await tools.execute("read", { path: "note.txt" }, signal)).toBe("after");
	writeFileSync(join(workspace, "twice.txt"), "x x");
	await expect(
		tools.execute(
			"edit",
			{ path: "twice.txt", oldText: "x", newText: "y" },
			signal,
		),
	).rejects.toThrow("oldText must occur exactly once");
	expect(readFileSync(join(workspace, "note.txt"), "utf8")).toBe("after");
});
