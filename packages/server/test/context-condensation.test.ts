import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../src/context/manager";
import {
	mergeCondensationMemory,
	selectCondensationItems,
	validateCondensationInput,
} from "../src/context/condensation";
import type { ContextItem } from "../src/context/types";
import { SessionStore } from "../src/sessions/store";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const input = {
	milestone: "tests complete",
	completedWork: ["implemented parser"],
	strategies: [],
	environmentChanges: [],
	constraints: ["keep API stable"],
	openQuestions: [],
	references: ["observation://obs-1", "src/parser.ts"],
};

test("validates references and merges newest duplicate entries within caps", () => {
	expect(validateCondensationInput(input)).toEqual(input);
	expect(() => validateCondensationInput({ ...input, references: ["/etc/passwd"] })).toThrow();
	expect(mergeCondensationMemory({ ...input, milestone: "old", completedWork: ["old"] }, input).completedWork).toEqual(["old", "implemented parser"]);
});

test("enforces every contract bound and trims strings", () => {
	expect(validateCondensationInput({ ...input, milestone: "  done  " }).milestone).toBe("done");
	for (const field of ["completedWork", "environmentChanges", "constraints", "openQuestions", "references"])
		expect(() => validateCondensationInput({ ...input, [field]: Array.from({ length: 21 }, () => "x") })).toThrow();
	expect(() => validateCondensationInput({ ...input, strategies: Array.from({ length: 21 }, () => ({ approach: "a", outcome: "b" })) })).toThrow();
	expect(() => validateCondensationInput({ ...input, milestone: "x".repeat(201) })).toThrow();
	expect(() => validateCondensationInput({ ...input, completedWork: [], constraints: [], references: [] })).toThrow();
	expect(() => validateCondensationInput({ ...input, references: ["observation://"] })).toThrow();
	expect(() => validateCondensationInput({ ...input, references: ["https://example.com"] })).toThrow();
	expect(validateCondensationInput({ ...input, completedWork: ["  complete  "] }).completedWork).toEqual(["complete"]);
});

test("deduplication keeps newest values, caps, and remains deterministic", () => {
	const prior = { ...input, completedWork: Array.from({ length: 20 }, (_, i) => `old-${i}`) };
	const merged = mergeCondensationMemory(prior, { ...input, completedWork: ["old-3", "new"] });
	expect(merged.completedWork).toHaveLength(20);
	expect(merged.completedWork.at(-1)).toBe("new");
	expect(merged.completedWork.filter((value) => value === "old-3")).toHaveLength(1);
	expect(mergeCondensationMemory(prior, input)).toEqual(mergeCondensationMemory(prior, input));
});

test("protects newest groups while selecting old retained exchanges", () => {
	const items = Array.from({ length: 6 }, (_, index) => ({
		id: String(index), sessionId: "s", sequence: index, kind: "tool-result" as const,
		originLane: "main", nodeRole: "message" as const, contentHash: String(index),
		payload: "x", tokenCost: 100, groupId: `g${index}`, lifecycle: "retained" as const,
		projection: "full" as const, reason: "done", createdAt: "now", updatedAt: "now",
	}));
	expect(selectCondensationItems(items).map((item) => item.id)).toEqual(["0", "1"]);
});

test("protects stable content, active/current work, predecessor groups, and completed episode boundaries", () => {
	const base = (id: string, sequence: number, extra: Partial<ContextItem> = {}): ContextItem => ({
		id, sessionId: "s", sequence, kind: "tool-result" as const, payload: "x", tokenCost: 100,
		lifecycle: "retained" as const, projection: "full" as const, reason: "done", createdAt: "now", updatedAt: "now", ...extra,
		originLane: extra.originLane ?? "main", nodeRole: extra.nodeRole ?? "message", contentHash: extra.contentHash ?? id,
	});
	const items = [
		base("system", 1, { kind: "system", lifecycle: "pinned" }),
		base("user", 2, { kind: "user", lifecycle: "pinned" }),
		base("pin", 3, { kind: "pinned-note", lifecycle: "pinned" }),
		base("obs", 4, { kind: "observation", lifecycle: "archived" }),
		base("active", 5, { lifecycle: "active", episodeId: "ep-active" }),
		base("old-assistant", 6, { kind: "assistant", groupId: "old" }),
		base("old-tool", 7, { groupId: "old" }),
		base("episode", 8, { episodeId: "ep-complete" }),
		base("terminal-assistant", 9, { kind: "assistant", groupId: "terminal" }),
		base("terminal-tool", 10, { groupId: "terminal" }),
		...Array.from({ length: 4 }, (_, index) => [
			base(`new-${index}-assistant`, 11 + index * 2, { kind: "assistant", groupId: `new-${index}` }),
			base(`new-${index}-tool`, 12 + index * 2, { groupId: `new-${index}` }),
		]).flat(),
		base("current", 19, { groupId: "current" }),
	];
	const selected = selectCondensationItems(items, { currentTaskStartSequence: 19, predecessorTerminalIds: ["terminal-assistant"] });
	expect(selected.map((item) => item.id)).toEqual(["old-assistant", "old-tool", "episode"]);
	for (const id of ["system", "user", "pin", "obs", "active", "terminal-assistant", "terminal-tool", "new-0-assistant", "new-0-tool", "new-1-assistant", "new-1-tool", "new-2-assistant", "new-2-tool", "new-3-assistant", "new-3-tool", "current"])
		expect(selected.map((item) => item.id)).not.toContain(id);
});

describe("ContextManager.condense", () => {
	test("replaces eligible history atomically and leaves observations intact", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-condensation-test-"));
		paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite"));
		const sessionId = store.create();
		const manager = new ContextManager(store);
		for (let index = 0; index < 5; index++)
			manager.record({ sessionId, kind: "tool-result", payload: "completed", tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "done", groupId: `old-${index}` });
		manager.recordObservation(sessionId, "exact output", { observationId: "obs-1" });
		const result = manager.condense(sessionId, input);
		expect(result.noOp).toBe(false);
		expect(store.contextItems(sessionId).filter((item) => item.kind === "long-term-memory" && item.lifecycle !== "archived")).toHaveLength(1);
		expect(manager.recall(sessionId, "observation://obs-1").text).toBe("exact output");
	});

	test("assembles stable semantics, memory, then recent work", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-condensation-order-")); paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite")); const sessionId = store.create(); const manager = new ContextManager(store);
		manager.record({ sessionId, kind: "system", payload: "stable", tokenCost: 1, lifecycle: "pinned", projection: "full", reason: "system" });
		manager.record({ sessionId, kind: "user", payload: { role: "user", content: "objective" }, tokenCost: 1, lifecycle: "pinned", projection: "full", reason: "user" });
		for (let index = 0; index < 6; index++) manager.record({ sessionId, kind: "tool-result", payload: { role: "toolResult", content: `work-${index}` }, tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "done", groupId: `group-${index}` });
		manager.condense(sessionId, input);
		const assembly = manager.assemble(sessionId, { budget: 20_000, target: 20_000, overheadTokens: 0 });
		const memoryIndex = assembly.payloads.findIndex((payload) => JSON.stringify(payload).includes("<harnez-long-term-memory>"));
		expect(assembly.payloads.slice(0, memoryIndex)).toEqual([{ role: "user", content: "objective" }]);
		expect(assembly.payloads.slice(memoryIndex + 1)).toEqual(
			[2, 3, 4, 5].map((index) => ({ role: "toolResult", content: `work-${index}` })),
		);
	});

	test("keeps completed exploration conclusions and observation references in task assembly", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-condensation-episode-")); paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite")); const sessionId = store.create(); const manager = new ContextManager(store);
		manager.record({ sessionId, kind: "tool-result", payload: "before task", tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "setup" });
		const episode = manager.startEpisode(sessionId, { name: "inspect", kind: "exploration" });
		manager.record({ sessionId, kind: "assistant", payload: { role: "assistant", content: [{ type: "text", text: "found it" }] }, tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "episode work", episodeId: episode.id });
		manager.recordObservation(sessionId, "exact finding", { observationId: "obs-episode" });
		manager.endEpisode(sessionId, "the answer is stable");
		for (let index = 0; index < 6; index++) manager.record({ sessionId, kind: "tool-result", payload: `work-${index}`, tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "done", groupId: `group-${index}` });
		manager.condense(sessionId, input);
		const task = manager.assembleTask(sessionId, { budget: 50_000, target: 40_000, overheadTokens: 0, submissionWatermark: store.contextSequence(sessionId), taskStartSequence: 1, predecessorTerminalIds: [] });
		const text = JSON.stringify(task.payloads);
		expect(text).toContain("the answer is stable");
		expect(text).toContain("observation://obs-episode");
		expect(task.estimatedTokens).toBeGreaterThan(0);
	});

	test("is a no-op without eligible history and keeps one live memory on repeat", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-condensation-noop-")); paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite")); const sessionId = store.create(); const manager = new ContextManager(store);
		const first = manager.condense(sessionId, input);
		expect(first.noOp).toBe(true); expect(store.contextItems(sessionId)).toHaveLength(0);
		for (let index = 0; index < 6; index++) manager.record({ sessionId, kind: "tool-result", payload: `work-${index}`, tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "done", groupId: `g-${index}` });
		const created = manager.condense(sessionId, input); expect(created.noOp).toBe(false);
		expect(created.memoryTokens).toBeLessThanOrEqual(2_000);
		expect(created.tokensAfter).toBe(manager.inspect(sessionId).estimatedTokens);
		for (let index = 0; index < 6; index++) manager.record({ sessionId, kind: "tool-result", payload: `later-${index}`, tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "done", groupId: `later-${index}` });
		const again = manager.condense(sessionId, { ...input, milestone: "next", completedWork: ["new work"] });
		expect(again.noOp).toBe(false);
		expect(store.contextItems(sessionId).filter((item) => item.kind === "long-term-memory" && item.lifecycle !== "archived")).toHaveLength(1);
	});

	test("does not replace prior memory when no history is eligible", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-condensation-prior-noop-")); paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite")); const sessionId = store.create(); const manager = new ContextManager(store);
		for (let index = 0; index < 6; index++) manager.record({ sessionId, kind: "tool-result", payload: `work-${index}`, tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "done", groupId: `group-${index}` });
		expect(manager.condense(sessionId, input).noOp).toBe(false);
		const before = store.contextItems(sessionId).map((item) => [item.id, item.lifecycle, item.payload]);
		const result = manager.condense(sessionId, { ...input, milestone: "new memory" });
		expect(result.noOp).toBe(true);
		expect(store.contextItems(sessionId).map((item) => [item.id, item.lifecycle, item.payload])).toEqual(before);
	});

	test("rejects an over-budget memory without changing lifecycle state", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-condensation-budget-")); paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite")); const sessionId = store.create(); const manager = new ContextManager(store);
		for (let index = 0; index < 6; index++) manager.record({ sessionId, kind: "tool-result", payload: `work-${index}`, tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "done", groupId: `group-${index}` });
		const before = store.contextItems(sessionId).map((item) => [item.id, item.lifecycle]);
		expect(() => manager.condense(sessionId, { ...input, completedWork: Array.from({ length: 20 }, () => "x".repeat(1_000)) })).toThrow("2,000");
		expect(store.contextItems(sessionId).map((item) => [item.id, item.lifecycle])).toEqual(before);
	});

	test("rolls back lifecycle changes when storage append fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-condensation-rollback-")); paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite")); const sessionId = store.create(); const manager = new ContextManager(store);
		for (let index = 0; index < 6; index++) manager.record({ sessionId, kind: "tool-result", payload: `work-${index}`, tokenCost: 1_000, lifecycle: "retained", projection: "full", reason: "done", groupId: `g-${index}` });
		const before = store.contextItems(sessionId).map((item) => [item.id, item.lifecycle]);
		const append = store.appendContextItem.bind(store); store.appendContextItem = () => { throw new Error("storage failure"); };
		expect(() => manager.condense(sessionId, input)).toThrow("storage failure");
		expect(store.contextItems(sessionId).map((item) => [item.id, item.lifecycle])).toEqual(before);
		store.appendContextItem = append;
	});

	test("rejects active episodes before touching storage", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-condensation-active-")); paths.push(dir);
		const store = new SessionStore(join(dir, "state.sqlite")); const sessionId = store.create(); const manager = new ContextManager(store);
		manager.startEpisode(sessionId, { name: "active work", kind: "exploration" });
		expect(() => manager.condense(sessionId, input)).toThrow("episode is active");
		expect(store.contextItems(sessionId)).toHaveLength(0);
	});
});
