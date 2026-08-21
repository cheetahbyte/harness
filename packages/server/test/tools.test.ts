import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentTools, contextCapabilities } from "../src/agent/tools";
import { CapabilityCatalog } from "../src/capabilities/catalog";
import { ContextManager } from "../src/context/manager";
import { SessionStore } from "../src/sessions/store";
import {
	parentSubagentCapabilities,
	parentSubagentTools,
} from "../src/subagents/tools";
import { scanAgentProfiles } from "../src/subagents/profiles";
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
		HARNEZ_OTEL_CAPTURE_MAX_CHARS:
			process.env["HARNEZ_OTEL_CAPTURE_MAX_CHARS"],
		HARNEZ_TEST_ENV: process.env["HARNEZ_TEST_ENV"],
	};
	Object.assign(process.env, {
		OTEL_EXPORTER_OTLP_ENDPOINT: "http://secret.invalid",
		OTEL_EXPORTER_OTLP_HEADERS: "authorization=secret",
		HARNEZ_OTEL: "1",
		HARNEZ_OTEL_CAPTURE_CONTENT: "prompts",
		HARNEZ_OTEL_CAPTURE_MAX_CHARS: "64",
		HARNEZ_TEST_ENV: "kept",
	});
	try {
		const output = await execute(
			new CoreTools(workspace),
			"bash",
			{ command: "printf '%s|%s|%s|%s' \"$OTEL_EXPORTER_OTLP_ENDPOINT\" \"$HARNEZ_OTEL\" \"$HARNEZ_OTEL_CAPTURE_MAX_CHARS\" \"$HARNEZ_TEST_ENV\"" },
			new AbortController().signal,
		);
		expect(output).toBe("|||kept");
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});

test("registers every context tool as operator capability (modelDiscoverable: false)", () => {
	const capabilities = contextCapabilities("binding-1");
	const snapshot = new CapabilityCatalog(capabilities, "binding-1").snapshot({
		tool: { maxLevel: "execute", confirmation: "none" },
		skill: { maxLevel: "activate" },
	});

	expect(snapshot.list().items).toEqual([]);
	const ref = snapshot.reference("tool:recall_observation", "operator");
	expect(ref.id).toBe("tool:recall_observation");
	/** Paging belongs in the contract, not in folklore about the URI format. */
	expect(
		JSON.stringify(snapshot.inspect(ref).contract),
	).toContain("offset");
	expect(snapshot.inspect(ref).contract).toMatchObject({
		effect: "read_only",
	});
});

test("registers loaded subagent tools as operator capabilities (modelDiscoverable: false)", () => {
	const binding = "binding-1";
	const tools = parentSubagentTools({} as never, "session-1", [
		{ name: "only-agent", description: "The only configured subagent." },
	]);
	const snapshot = new CapabilityCatalog(
		parentSubagentCapabilities(tools, binding),
		binding,
	).snapshot({
		tool: { maxLevel: "execute", confirmation: "none" },
		skill: { maxLevel: "activate" },
	});

	expect(snapshot.list().items).toEqual([]);
	const getRef = snapshot.reference("tool:get_agent_result", "operator");
	expect(getRef.id).toBe("tool:get_agent_result");
	const spawn = snapshot.inspect(snapshot.reference("tool:spawn_agent", "operator"));
	expect(spawn.description).toContain(
		"only-agent: The only configured subagent.",
	);
	expect(JSON.stringify(spawn.contract)).toContain('"only-agent"');
});

test("waits for a child handoff instead of exposing polling", async () => {
	let options: unknown;
	const tools = parentSubagentTools(
		{
			get: async (_sessionId: string, _id: string, input: unknown) => {
				options = input;
				return { id: "child-1", state: "completed" };
			},
		} as never,
		"session-1",
		[{ name: "only-agent", description: "Only agent." }],
	);
	const get = tools.find((tool) => tool.name === "get_agent_result")!;
	expect(JSON.stringify(get.parameters)).not.toContain('"wait"');
	await get.execute(
		"call-1",
		{ id: "child-1" },
		new AbortController().signal,
	);
	expect(options).toMatchObject({ wait: true });
});

test("loads user agent profiles from the canonical config directory", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "harnez-profile-workspace-"));
	const home = mkdtempSync(join(tmpdir(), "harnez-profile-home-"));
	paths.push(workspace, home);
	const directory = join(home, ".config/harnez/agents");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "custom.md"),
		"---\nname: custom\ndescription: Custom profile.\ncapabilities: all\n---\nInspect.",
	);

	const scan = await scanAgentProfiles(workspace, home);
	expect(scan.profiles.find(({ name }) => name === "custom")?.path).toBe(
		join(directory, "custom.md"),
	);
});

test("condense_context reports mutation details, suppresses no-op events, and allows active episodes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "harnez-tool-condense-"));
	const store = new SessionStore(join(dir, "state.sqlite"));
	const sessionId = store.create();
	const telemetry: unknown[] = [];
	const context = new ContextManager(store, (event) => telemetry.push(event));
	for (let index = 0; index < 6; index++)
		context.record({ sessionId, kind: "tool-result", payload: `work-${index}`, tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "done", groupId: `group-${index}` });
	const events: unknown[] = [];
	const tools = agentTools({
		sessionId,
		model: { id: "model" } as never,
		tools: { agentTools: () => [], contextMetadata: () => ({}) } as never,
		task: { id: "task-1", taskStartSequence: undefined, predecessorTerminalMessageIds: [], snapshot: {} } as never,
		skills: [], mcpTools: [], mcp: { call: async () => "" }, admit: () => {},
		context, contextOptions: () => ({ budget: 20_000, target: 20_000, overheadTokens: 0 }), previewLimit: () => 100,
		emit: (event) => events.push(event),
	});
	const tool = tools.find((candidate) => candidate.name === "condense_context")!;
	const result = await tool.execute("call", { milestone: "done", completedWork: ["work"], strategies: [], environmentChanges: [], constraints: [], openQuestions: [], references: [] }, new AbortController().signal);
	expect(result.details).toMatchObject({ noOp: false, archivedItems: 2 });
	expect(JSON.stringify(result.details)).not.toContain("work");
	const memory = store.contextItems(sessionId).find((item) => item.kind === "long-term-memory" && item.lifecycle !== "archived");
	expect(memory).toMatchObject({ lifecycle: "pinned", projection: "full", reason: "agent context condensation" });
	const checkpoint = memory?.payload as { representation?: { kind?: string; memory?: unknown } };
	expect(checkpoint.representation?.kind).toBe("condensation");
	expect(checkpoint.representation?.memory).toMatchObject({ milestone: "done", completedWork: ["work"] });
	expect(events).toHaveLength(1);
	const assembly = telemetry.find((event) => (event as { type?: string }).type === "context.assembly.completed") as Record<string, unknown>;
	expect(assembly).toMatchObject({ budget: 20_000, target: 20_000, taskId: "task-1" });
	const noop = await tool.execute("call-2", { milestone: "short", completedWork: ["x"], strategies: [], environmentChanges: [], constraints: [], openQuestions: [], references: [] }, new AbortController().signal);
	expect(noop.content[0]).toMatchObject({ text: "No context was condensed." });
	expect(events).toHaveLength(1);
	context.startEpisode(sessionId, { name: "active", kind: "exploration" });
	const active = await tool.execute("call-3", { milestone: "blocked", completedWork: ["x"], strategies: [], environmentChanges: [], constraints: [], openQuestions: [], references: [] }, new AbortController().signal);
	expect(active.content[0]).toMatchObject({ text: "No context was condensed." });
	rmSync(dir, { recursive: true, force: true });
});

test("BashTool appends advisory warning on repeated identical commands and sleep loops", async () => {
	const workspace = mkdtempSync(join(tmpdir(), "harnez-bash-loop-"));
	paths.push(workspace);
	const tools = new CoreTools(workspace);
	const signal = new AbortController().signal;

	// Executing same command twice should not trigger advisory
	await execute(tools, "bash", { command: "echo test" }, signal);
	const res2 = await execute(tools, "bash", { command: "echo test" }, signal);
	expect(res2).not.toContain("[advisory:");

	// Third identical command triggers advisory
	const res3 = await execute(tools, "bash", { command: "echo test" }, signal);
	expect(res3).toContain("[advisory: repeated identical command");

	// Sleep loop tracking
	const tools2 = new CoreTools(workspace);
	for (let i = 0; i < 3; i++) {
		const res = await execute(tools2, "bash", { command: `echo sleep-${i}; sleep 0` }, signal);
		expect(res).not.toContain("[advisory:");
	}
	const resSleep4 = await execute(tools2, "bash", { command: "echo sleep-4; sleep 0" }, signal);
	expect(resSleep4).toContain("[advisory: repeated identical command");
});

test("marks first-party capabilities modelDiscoverable: false", () => {
	const coreCaps = new CoreTools("/tmp").capabilities("binding");
	expect(coreCaps.every((c) => c.modelDiscoverable === false)).toBe(true);

	const contextCaps = contextCapabilities("binding");
	expect(contextCaps.every((c) => c.modelDiscoverable === false)).toBe(true);

	const subagentCaps = parentSubagentCapabilities(
		[{ name: "spawn_agent", description: "spawn", parameters: {} as never, label: "spawn", execute: async () => ({ content: [], details: {} }) }],
		"binding",
	);
	expect(subagentCaps.every((c) => c.modelDiscoverable === false)).toBe(true);
});

test("spawn_agent tool description mentions retrieval and returns nextStep hint", async () => {
	const tools = parentSubagentTools(
		{
			spawn: async () => {
				return {
					id: "child-123",
					state: "queued",
					nextStep: 'Call get_agent_result("child-123") to block until the handoff is ready.',
				};
			},
		} as never,
		"session-1",
		[{ name: "explore", description: "Explore profile." }],
	);

	const spawn = tools.find((t) => t.name === "spawn_agent")!;
	expect(spawn.description).toContain("Call get_agent_result with the returned ID to wait for its output.");

	const result = await spawn.execute(
		"call-1",
		{ profile: "explore", task: "do work", description: "work" },
		new AbortController().signal,
	);
	const text = result.content.find((c) => c.type === "text")?.text ?? "";
	expect(JSON.parse(text)).toMatchObject({
		id: "child-123",
		state: "queued",
		nextStep: 'Call get_agent_result("child-123") to block until the handoff is ready.',
	});
});

