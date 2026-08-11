import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextBudgetError, ContextManager } from "../src/context/manager";
import { MAX_OBSERVATION_RECALL_LIMIT } from "../src/context/recall";
import { SessionStore } from "../src/session-store";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function storePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "harness-context-test-"));
	paths.push(dir);
	return join(dir, "state.sqlite");
}

describe("ContextManager", () => {
	test("keeps context payloads immutable while lifecycle changes persist", () => {
		const path = storePath();
		const store = new SessionStore(path);
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const raw = {
			role: "toolResult",
			toolCallId: "call-1",
			content: [{ type: "text", text: "x".repeat(200) }],
		};

		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "keep me" },
			tokenCost: 3,
			lifecycle: "pinned",
			reason: "user input",
		});
		const item = manager.record({
			sessionId,
			kind: "tool-result",
			payload: raw,
			compactPayload: {
				...raw,
				content: [{ type: "text", text: "observation://obs-1" }],
			},
			tokenCost: 50,
			compactTokenCost: 8,
			lifecycle: "retained",
			reason: "consumed",
			source: {
				toolCallId: "call-1",
				toolName: "read",
				observationId: "obs-1",
				isError: false,
			},
			groupId: "assistant-1",
		});
		manager.archive(item.id, "working-context budget");
		store.db.close();

		const reopened = new SessionStore(path);
		expect(reopened.contextItem(item.id)?.payload).toEqual(raw);
		expect(reopened.contextItem(item.id)?.lifecycle).toBe("archived");
		expect(reopened.contextItem(item.id)?.reason).toBe("working-context budget");
		reopened.db.close();
	});

	test("validates and reconstructs episode boundaries while attaching active work", () => {
		const path = storePath();
		const store = new SessionStore(path);
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const exploration = manager.startEpisode(sessionId, {
			name: "inspect-auth",
			kind: "exploration",
		});

		expect(() =>
			manager.startEpisode(sessionId, { name: "other", kind: "exploration" }),
		).toThrow("already active");
		expect(() => manager.endEpisode(sessionId)).toThrow("conclusion");
		const attached = manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "reading auth" },
			tokenCost: 2,
			lifecycle: "active",
			reason: "work",
		});
		expect(attached.episodeId).toBe(exploration.id);
		expect(
			manager.record({
				sessionId,
				episodeId: "explicit-episode",
				kind: "assistant",
				payload: { role: "assistant", content: "separate" },
				tokenCost: 1,
				lifecycle: "active",
				reason: "work",
			}).episodeId,
		).toBe("explicit-episode");
		expect(
			manager.record({
				sessionId,
				kind: "user",
				payload: { role: "user", content: "do not lose this" },
				tokenCost: 2,
				lifecycle: "active",
				reason: "input",
			}).lifecycle,
		).toBe("pinned");
		manager.endEpisode(sessionId, "JWT validation happens before routing.");
		expect(() =>
			manager.startEpisode(sessionId, {
				name: "inspect-auth",
				kind: "exploration",
			}),
		).toThrow("unique");
		expect(() =>
			manager.startEpisode(sessionId, {
				name: "bad-exploration",
				kind: "exploration",
				dependencies: [exploration.id],
			}),
		).toThrow("cannot have dependencies");
		expect(() =>
			manager.startEpisode(sessionId, { name: "no-dependency", kind: "action" }),
		).toThrow("require an exploration dependency");
		const action = manager.startEpisode(sessionId, {
			name: "patch-auth",
			kind: "action",
			dependencies: [exploration.id],
		});
		expect(() => manager.endEpisode(sessionId, "not allowed")).toThrow(
			"cannot have a conclusion",
		);
		manager.endEpisode(sessionId);
		store.db.close();

		const reopened = new SessionStore(path);
		expect(new ContextManager(reopened).episodes(sessionId)).toMatchObject([
			{ id: exploration.id, state: "completed", conclusion: "JWT validation happens before routing." },
			{ id: action.id, state: "completed", dependencies: [exploration.id] },
		]);
		reopened.db.close();
	});

	test("records unknown kinds and lifecycles as pinned", () => {
		const store = new SessionStore(storePath());
		const manager = new ContextManager(store);
		const item = manager.record({
			sessionId: store.create(),
			kind: "future-message" as never,
			payload: { role: "future" },
			tokenCost: 1,
			lifecycle: "active",
			reason: "unknown input",
		});

		expect(item.lifecycle).toBe("pinned");
		expect(
			manager.record({
				sessionId: item.sessionId,
				kind: "user",
				payload: { role: "user" },
				tokenCost: 1,
				lifecycle: "future-state" as never,
				reason: "unknown input",
			}).lifecycle,
		).toBe("pinned");
		store.db.close();
	});

	test("uses the cached active episode while recording", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.startEpisode(sessionId, { name: "inspect", kind: "exploration" });
		const episodeEvents = store.episodeEvents.bind(store);
		let reads = 0;
		store.episodeEvents = (id) => {
			reads++;
			return episodeEvents(id);
		};

		manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "first" },
			tokenCost: 1,
			lifecycle: "active",
			reason: "work",
		});
		manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "second" },
			tokenCost: 1,
			lifecycle: "active",
			reason: "work",
		});

		expect(reads).toBe(0);
		store.db.close();
	});

	test("retains only tool results from an older turn", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const older = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", toolCallId: "old-call" },
			tokenCost: 1,
			lifecycle: "active",
			reason: "new tool result",
			source: { toolCallId: "old-call" },
		});
		const current = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", toolCallId: "current-call" },
			tokenCost: 1,
			lifecycle: "active",
			reason: "new tool result",
			source: { toolCallId: "current-call" },
		});

		manager.completeTurn(sessionId, ["current-call"]);

		expect(store.contextItem(older.id)?.lifecycle).toBe("retained");
		expect(store.contextItem(current.id)?.lifecycle).toBe("active");
		store.db.close();
	});

	test("persists episode events in order", () => {
		const path = storePath();
		const store = new SessionStore(path);
		const sessionId = store.create();
		store.appendEpisodeEvent({
			id: "episode-start",
			sessionId,
			episodeId: "episode-1",
			action: "start",
			name: "investigate",
			kind: "exploration",
			dependencies: [],
			createdAt: "2026-08-10T00:00:00.000Z",
		});
		store.appendEpisodeEvent({
			id: "episode-end",
			sessionId,
			episodeId: "episode-1",
			action: "end",
			name: "investigate",
			kind: "exploration",
			dependencies: ["previous-exploration"],
			conclusion: "Found the root cause.",
			createdAt: "2026-08-10T00:01:00.000Z",
		});
		store.db.close();

		const reopened = new SessionStore(path);
		expect(reopened.episodeEvents(sessionId)).toMatchObject([
			{
				id: "episode-start",
				sequence: 1,
				dependencies: [],
			},
			{
				id: "episode-end",
				sequence: 2,
				dependencies: ["previous-exploration"],
				conclusion: "Found the root cause.",
			},
		]);
		reopened.db.close();
	});

	test("archives actions before explorations and preserves compact conclusions", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "keep" },
			tokenCost: 10,
			lifecycle: "active",
			reason: "input",
		});
		const exploration = manager.startEpisode(sessionId, {
			name: "inspect-auth",
			kind: "exploration",
		});
		const raw = { role: "assistant", content: "long investigation" };
		const explorationItem = manager.record({
			sessionId,
			kind: "assistant",
			payload: raw,
			tokenCost: 30,
			lifecycle: "active",
			reason: "investigating",
		});
		manager.endEpisode(sessionId, "JWT validation happens before routing.");
		const action = manager.startEpisode(sessionId, {
			name: "patch-auth",
			kind: "action",
			dependencies: [exploration.id],
		});
		const actionItem = manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "apply patch" },
			tokenCost: 30,
			lifecycle: "active",
			reason: "editing",
		});
		manager.endEpisode(sessionId);
		const open = manager.startEpisode(sessionId, {
			name: "verify",
			kind: "exploration",
		});
		const openItem = manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "checking" },
			tokenCost: 30,
			lifecycle: "active",
			reason: "verifying",
		});

		const assembly = manager.assemble(sessionId, {
			budget: 90,
			target: 60,
			overheadTokens: 0,
		});
		const inspection = manager.inspect(sessionId, {
			budget: 90,
			target: 60,
			overheadTokens: 0,
		});

		expect(assembly.evictedIds).toEqual([actionItem.id, explorationItem.id]);
		expect(inspection).toMatchObject({
			budget: 90,
			target: 60,
			overheadTokens: 0,
			episodes: [
				{ id: exploration.id, state: "archived" },
				{ id: action.id, state: "archived" },
				{ id: open.id, state: "active" },
			],
		});
		expect(assembly.payloads).toContainEqual(
			expect.objectContaining({ content: expect.stringContaining("JWT validation") }),
		);
		expect(store.contextItem(explorationItem.id)?.payload).toEqual(raw);
		expect(store.contextItem(openItem.id)?.lifecycle).toBe("active");
		expect("payload" in inspection.items[0]!).toBe(false);
		store.db.close();
	});

	test("keeps an exploration completed while a dependent action remains live", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "keep" },
			tokenCost: 10,
			lifecycle: "pinned",
			reason: "input",
		});
		const exploration = manager.startEpisode(sessionId, {
			name: "inspect",
			kind: "exploration",
		});
		manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "findings" },
			tokenCost: 40,
			lifecycle: "active",
			reason: "work",
		});
		manager.endEpisode(sessionId, "The failure is in auth.");
		const action = manager.startEpisode(sessionId, {
			name: "fix",
			kind: "action",
			dependencies: [exploration.id],
		});
		manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "patch" },
			tokenCost: 40,
			lifecycle: "active",
			reason: "work",
		});
		manager.endEpisode(sessionId);

		manager.assemble(sessionId, { budget: 80, target: 50, overheadTokens: 0 });
		expect(manager.episodes(sessionId)).toMatchObject([
			{ id: exploration.id, state: "completed" },
			{ id: action.id, state: "archived" },
		]);
		store.db.close();
	});

	test("evicts retained tool results only after crossing the budget", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "keep" },
			tokenCost: 49,
			lifecycle: "pinned",
			reason: "user input",
		});
		const oldTool = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large output" },
			compactPayload: { role: "toolResult", content: "observation://old" },
			tokenCost: 50,
			compactTokenCost: 10,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read" },
		});

		expect(
			manager.assemble(sessionId, {
				budget: 100,
				target: 80,
				overheadTokens: 0,
			}).estimatedTokens,
		).toBe(99);
		expect(store.contextItem(oldTool.id)?.lifecycle).toBe("retained");

		manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "new output" },
			tokenCost: 2,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "bash" },
		});
		const assembly = manager.assemble(sessionId, {
			budget: 100,
			target: 80,
			overheadTokens: 0,
		});

		expect(assembly.estimatedTokens).toBeLessThanOrEqual(80);
		expect(assembly.evictedIds).toEqual([oldTool.id]);
		expect(store.contextItem(oldTool.id)?.reason).toBe(
			"working-context budget",
		);
		store.db.close();
	});

	test("evicts successful tool results by persisted priority metadata", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "keep" },
			tokenCost: 10,
			lifecycle: "pinned",
			reason: "user input",
		});
		const bash = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "bash" },
			compactPayload: { role: "toolResult", content: "bash ref" },
			tokenCost: 50,
			compactTokenCost: 10,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "bash", evictionPriority: "late" },
		});
		const read = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "read" },
			compactPayload: { role: "toolResult", content: "read ref" },
			tokenCost: 50,
			compactTokenCost: 10,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read", evictionPriority: "normal" },
		});
		const write = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "write" },
			compactPayload: { role: "toolResult", content: "write ref" },
			tokenCost: 50,
			compactTokenCost: 10,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "write", evictionPriority: "early" },
		});

		const assembly = manager.assemble(sessionId, {
			budget: 150,
			target: 80,
			overheadTokens: 0,
		});

		expect(assembly.evictedIds).toEqual([write.id, read.id]);
		expect(store.contextItem(bash.id)?.lifecycle).toBe("retained");
		store.db.close();
	});

	test("retires and evicts a completed tool exchange as one group", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const assistant = manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "tool call" },
			tokenCost: 40,
			groupId: "exchange-1",
			lifecycle: "active",
			reason: "active tool call",
		});
		const result = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large output" },
			compactPayload: { role: "user", content: "observation://old" },
			tokenCost: 60,
			compactTokenCost: 5,
			groupId: "exchange-1",
			lifecycle: "active",
			reason: "active tool result",
			source: { toolCallId: "call-1", toolName: "read" },
		});
		const secondResult = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "other output" },
			compactPayload: { role: "user", content: "observation://other" },
			tokenCost: 10,
			compactTokenCost: 2,
			groupId: "exchange-1",
			lifecycle: "active",
			reason: "active tool result",
			source: { toolCallId: "call-2", toolName: "read" },
		});

		manager.completeTurn(sessionId);
		expect(store.contextItem(assistant.id)?.lifecycle).toBe("retained");
		expect(store.contextItem(result.id)?.lifecycle).toBe("retained");
		expect(store.contextItem(secondResult.id)?.lifecycle).toBe("retained");

		const assembly = manager.assemble(sessionId, {
			budget: 90,
			target: 70,
			overheadTokens: 0,
		});
		expect(assembly.evictedIds).toEqual([
			assistant.id,
			result.id,
			secondResult.id,
		]);
		expect(assembly.payloads).toEqual([
			{ role: "user", content: "observation://old" },
			{ role: "user", content: "observation://other" },
		]);
		expect(store.contextItem(assistant.id)?.projection).toBe("omitted");
		store.db.close();
	});

	test("retires old text turns while preserving the initial objective", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const objective = manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "objective" },
			tokenCost: 20,
			groupId: "turn-1",
			lifecycle: "pinned",
			reason: "initial user objective",
		});
		const oldMessage = manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "old follow-up" },
			tokenCost: 40,
			groupId: "turn-2",
			lifecycle: "active",
			reason: "active user turn",
		});
		const oldAssistant = manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "old reply" },
			tokenCost: 40,
			groupId: "turn-2",
			lifecycle: "active",
			reason: "recent assistant turn",
		});

		manager.completeGroup(sessionId, "turn-2");
		const assembly = manager.assemble(sessionId, {
			budget: 90,
			target: 30,
			overheadTokens: 0,
		});
		expect(assembly.evictedIds).toEqual([oldMessage.id, oldAssistant.id]);
		expect(assembly.payloads).toEqual([
			{ role: "user", content: "objective" },
		]);
		expect(store.contextItem(objective.id)?.lifecycle).toBe("pinned");
		store.db.close();
	});

	test("rejects an unsatisfiable pinned-only budget", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "cannot remove" },
			tokenCost: 11,
			lifecycle: "pinned",
			reason: "user input",
		});

		expect(() =>
			manager.assemble(sessionId, {
				budget: 10,
				target: 8,
				overheadTokens: 0,
			}),
		).toThrow(ContextBudgetError);
		store.db.close();
	});

	test("accepts protected context below the hard budget when target is unreachable", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "protected" },
			tokenCost: 70,
			lifecycle: "pinned",
			reason: "user input",
		});
		manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large" },
			compactPayload: { role: "user", content: "reference" },
			tokenCost: 40,
			compactTokenCost: 10,
			lifecycle: "retained",
			reason: "consumed",
		});

		expect(
			manager.assemble(sessionId, {
				budget: 100,
				target: 50,
				overheadTokens: 0,
			}).estimatedTokens,
		).toBe(80);
		store.db.close();
	});

	test("recalls exact observation slices from canonical URIs", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const observation = manager.recordObservation(sessionId, "0123456789", {
			toolCallId: "call-1",
			toolName: "read",
		});
		const observationId = observation.source?.observationId;

		expect(observation).toMatchObject({
			id: observationId,
			kind: "observation",
			lifecycle: "archived",
			projection: "omitted",
			payload: "0123456789",
		});
		expect(
			manager.recall(sessionId, `observation://${observationId}?offset=3&limit=4`),
		).toMatchObject({
			observationId,
			text: "3456",
			offset: 3,
			limit: 4,
			totalLength: 10,
		});
		store.db.close();
	});

	test("rejects cross-session and invalid observation recalls", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const observation = new ContextManager(store).recordObservation(
			sessionId,
			"private",
		);
		const uri = `observation://${observation.source?.observationId}`;

		expect(() => new ContextManager(store).recall(store.create(), uri)).toThrow(
			"Observation not found",
		);
		expect(() => new ContextManager(store).recall(sessionId, "not-a-uri")).toThrow(
			"Invalid observation URI",
		);
		expect(() => new ContextManager(store).recall(sessionId, `${uri}?limit=1.5`)).toThrow(
			"Invalid observation limit",
		);
		store.db.close();
	});

	test("limits observation recalls to 64k characters", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const observation = new ContextManager(store).recordObservation(
			sessionId,
			"x".repeat(MAX_OBSERVATION_RECALL_LIMIT + 1),
		);
		const uri = `observation://${observation.source?.observationId}`;

		expect(
			new ContextManager(store).recall(
				sessionId,
				`${uri}?limit=${MAX_OBSERVATION_RECALL_LIMIT}`,
			).text,
		).toHaveLength(MAX_OBSERVATION_RECALL_LIMIT);
		expect(() =>
			new ContextManager(store).recall(
				sessionId,
				`${uri}?limit=${MAX_OBSERVATION_RECALL_LIMIT + 1}`,
			),
		).toThrow("Invalid observation limit");
		store.db.close();
	});

	test("keeps omitted observations recoverable after eviction and reopen", () => {
		const path = storePath();
		const store = new SessionStore(path);
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const observation = manager.recordObservation(sessionId, "exact raw output");
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "keep" },
			tokenCost: 49,
			lifecycle: "pinned",
			reason: "user input",
		});
		const tool = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large output" },
			compactPayload: { role: "toolResult", content: "reference" },
			tokenCost: 50,
			compactTokenCost: 10,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read" },
		});
		manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "new output" },
			tokenCost: 2,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "bash" },
		});

		expect(
			manager.assemble(sessionId, {
				budget: 100,
				target: 80,
				overheadTokens: 0,
			}).evictedIds,
		).toEqual([tool.id]);
		store.db.close();

		const reopened = new SessionStore(path);
		expect(
			new ContextManager(reopened).recall(
				sessionId,
				`observation://${observation.source?.observationId}`,
			).text,
		).toBe("exact raw output");
		reopened.db.close();
	});

	test("pins model-valid notes atomically within the current budget", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const tool = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large" },
			compactPayload: { role: "toolResult", content: "ref" },
			tokenCost: 10,
			compactTokenCost: 1,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read" },
		});
		const note = manager.pin(sessionId, "constraint", "note", {
			budget: 2,
			target: 2,
			overheadTokens: 0,
		});

		expect(note).toMatchObject({
			kind: "pinned-note",
			payload: { role: "user", content: "note", kind: "constraint" },
		});
		expect(
			manager.assemble(sessionId, {
				budget: 2,
				target: 2,
				overheadTokens: 0,
			}).estimatedTokens,
		).toBeLessThanOrEqual(2);
		expect(store.contextItem(tool.id)?.lifecycle).toBe("archived");

		const before = store.contextItems(sessionId);
		expect(() =>
			manager.pin(sessionId, "decision", "another", {
				budget: 2,
				target: 2,
				overheadTokens: 0,
			}),
		).toThrow(ContextBudgetError);
		expect(store.contextItems(sessionId)).toEqual(before);
		expect(() =>
			manager.record(
				{
					sessionId,
					kind: "user",
					payload: { role: "user", content: "too much" },
					tokenCost: 2,
					lifecycle: "pinned",
					reason: "user input",
				},
				{ budget: 2, target: 2, overheadTokens: 0 },
			),
		).toThrow(ContextBudgetError);
		expect(store.contextItems(sessionId)).toEqual(before);
		expect(() =>
			manager.pin(sessionId, "constraint", "  ", { budget: 2 }),
		).toThrow(
			"Pinned note cannot be empty",
		);
		store.db.close();
	});

	test("stores structured subagent handoffs and exposes metadata-only inspection", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const result = {
			status: "completed" as const,
			findings: ["JWT checks happen in middleware"],
			decisions: ["keep middleware boundary"],
			changedFiles: ["src/auth.ts"],
			verification: ["auth tests pass"],
			unresolvedIssues: [],
			artifactRefs: ["subagent://task-42"],
		};
		const handoff = manager.recordSubagentResult(sessionId, result, {
			subagentId: "task-42",
		});

		expect(store.contextItem(handoff.id)?.payload).toEqual(result);
		expect(manager.assemble(sessionId, {
			budget: 1_000,
			target: 800,
			overheadTokens: 0,
		}).payloads).toEqual([
			expect.objectContaining({
				role: "user",
				content: expect.stringContaining("JWT checks happen in middleware"),
			}),
		]);
		const inspection = manager.inspect(sessionId);
		expect(inspection).toMatchObject({
			sessionId,
			counts: { pinned: 0, active: 0, retained: 1, archived: 0 },
			items: [
				{
					id: handoff.id,
					kind: "subagent-handoff",
					lifecycle: "retained",
					projection: "compact",
					reason: "structured subagent handoff",
				},
			],
		});
		expect("payload" in inspection.items[0]!).toBe(false);
		store.db.close();
	});

	test(
		"keeps a long tool run below budget without deleting raw history",
		() => {
			const store = new SessionStore(storePath());
			const sessionId = store.create();
			const manager = new ContextManager(store);
			const raw = "x".repeat(16_000);
			manager.record({
				sessionId,
				kind: "user",
				payload: { role: "user", content: "keep the objective" },
				tokenCost: 10,
				lifecycle: "pinned",
				reason: "user objective",
			});
			store.db.transaction(() => {
				for (let index = 0; index < 100; index++) {
					const groupId = `group-${index}`;
					manager.record({
						sessionId,
						kind: "assistant",
						payload: { role: "assistant", content: `call ${index}` },
						tokenCost: 20,
						groupId,
						lifecycle: "retained",
						reason: "completed tool call",
					});
					manager.record({
						sessionId,
						kind: "tool-result",
						payload: { role: "toolResult", content: raw },
						compactPayload: {
							role: "user",
							content: `observation://obs-${index}`,
						},
						tokenCost: 4_000,
						compactTokenCost: 5,
						groupId,
						lifecycle: "retained",
						reason: "completed tool result",
						source: { toolCallId: `call-${index}`, toolName: "read" },
					});
				}
			})();

			const assembly = manager.assemble(sessionId, {
				budget: 2_000,
				target: 1_600,
				overheadTokens: 100,
			});
			expect(assembly.estimatedTokens).toBeLessThanOrEqual(1_600);
			expect(JSON.stringify(assembly.payloads)).not.toContain(raw);
			expect(store.contextItems(sessionId)).toHaveLength(201);
			expect(store.contextItems(sessionId)[0]).toMatchObject({
				lifecycle: "pinned",
				projection: "full",
			});
			store.db.close();
		},
		20_000,
	);
});
