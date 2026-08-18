import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextCapabilities } from "../src/agent/tools";
import { CapabilityCatalog } from "../src/capabilities/catalog";
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
		"write",
		{ path: "nested/note.txt", content: "nested" },
		signal,
	);
	await execute(
		tools,
		"edit",
		{ path: "note.txt", oldText: "before", newText: "after" },
		signal,
	);
	expect(await execute(tools, "read", { path: "note.txt" }, signal)).toBe("after");
	expect(await execute(tools, "read", { path: "nested/note.txt" }, signal)).toBe(
		"nested",
	);
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

test("bash children keep ordinary environment but lose telemetry settings", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "harnez-tools-"));
	paths.push(workspace);
	const saved = {
		OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
		OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],
		HARNEZ_OTEL: process.env["HARNEZ_OTEL"],
		HARNEZ_OTEL_CAPTURE_CONTENT: process.env["HARNEZ_OTEL_CAPTURE_CONTENT"],
		HARNEZ_TEST_ENV: process.env["HARNEZ_TEST_ENV"],
	};
	Object.assign(process.env, {
		OTEL_EXPORTER_OTLP_ENDPOINT: "http://secret.invalid",
		OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
		HARNEZ_OTEL: "1",
		HARNEZ_OTEL_CAPTURE_CONTENT: "prompts",
		HARNEZ_TEST_ENV: "kept",
	});
	try {
		const output = await execute(
			new CoreTools(workspace),
			"bash",
			{ command: "printf '%s|%s|%s' \"$OTEL_EXPORTER_OTLP_ENDPOINT\" \"$HARNEZ_OTEL\" \"$HARNEZ_TEST_ENV\"" },
			new AbortController().signal,
		);
		expect(output).toBe("||kept");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("registers every context tool as a discoverable capability", () => {
	const capabilities = contextCapabilities("binding-1");
	const snapshot = new CapabilityCatalog(capabilities, "binding-1").snapshot({
		tool: { maxLevel: "execute", confirmation: "none" },
		skill: { maxLevel: "activate" },
	});

	expect(snapshot.list().items.map((item) => item.ref.id)).toEqual([
		"tool:episode",
		"tool:pin_context",
		"tool:recall_observation",
	]);
	const recall = snapshot.search("observation").items[0];
	expect(recall?.ref.id).toBe("tool:recall_observation");
	/** Paging belongs in the contract, not in folklore about the URI format. */
	expect(
		JSON.stringify(snapshot.inspect(recall!.ref).contract),
	).toContain("offset");
	expect(snapshot.inspect(recall!.ref).contract).toMatchObject({
		effect: "read_only",
	});
});
