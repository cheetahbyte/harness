import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ContextBudgetError,
	ContextManager,
	PRESSURE_NOTE,
	PRESSURE_NOTE_REASON,
	PRESSURE_NOTE_TOKENS,
	ROLLING_SUMMARY_REASON,
} from "../src/context/manager";
import { MAX_OBSERVATION_RECALL_LIMIT } from "../src/context/recall";
import { SessionStore } from "../src/sessions/store";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function storePath(): string {
	const dir = mkdtempSync(join(tmpdir(), "harnez-context-test-"));
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

	test("compacts pinned-only overflow down to the hard budget", () => {
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

		const assembly = manager.assemble(sessionId, {
			budget: 10,
			target: 8,
			overheadTokens: 0,
		});

		expect(assembly.estimatedTokens).toBeLessThanOrEqual(10);
		expect(assembly.payloads).toEqual([
			expect.objectContaining({
				role: "user",
				content: expect.stringContaining("cannot remove"),
			}),
		]);
		const items = store.contextItems(sessionId);
		expect(items[0]).toMatchObject({
			lifecycle: "archived",
			projection: "omitted",
		});
		expect(items[1]).toMatchObject({
			kind: "user",
			lifecycle: "pinned",
			reason: ROLLING_SUMMARY_REASON,
		});
		store.db.close();
	});

	test("still rejects budgets that cannot seat even the smallest summary", () => {
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
				overheadTokens: 9,
			}),
		).toThrow(ContextBudgetError);
		expect(store.contextItems(sessionId)[0]?.lifecycle).toBe("pinned");
		store.db.close();
	});

	test("terminalizes completed task prose as retained and reclaimable", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const objective = manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "objective" },
			tokenCost: 5,
			lifecycle: "pinned",
			reason: "user input",
		});
		const terminal = manager.record({
			sessionId,
			kind: "assistant",
			payload: {
				role: "assistant",
				content: [{ type: "text", text: "done the work" }],
			},
			tokenCost: 40,
			groupId: "exchange-1",
			lifecycle: "active",
			reason: "work",
		});
		const tool = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large output" },
			compactPayload: { role: "user", content: "observation://old" },
			tokenCost: 60,
			compactTokenCost: 5,
			groupId: "exchange-1",
			lifecycle: "active",
			reason: "tool result",
			source: { toolCallId: "call-1", toolName: "read" },
		});

		/** The original terminal message is reused rather than cloned. */
		expect(manager.terminalizeTask(sessionId, objective.sequence)).toEqual([
			terminal.id,
		]);
		expect(
			store
				.contextItems(sessionId)
				.some(
					(item) =>
						item.reason === "predecessor terminal user-visible message",
				),
		).toBe(false);
		expect(store.contextItem(terminal.id)?.lifecycle).toBe("retained");
		expect(store.contextItem(tool.id)?.lifecycle).toBe("archived");

		/** Retained prose is reclaimable by ordinary budget eviction. */
		const assembly = manager.assemble(sessionId, {
			budget: 20,
			target: 10,
			overheadTokens: 0,
		});
		expect(assembly.evictedIds).toEqual([terminal.id]);
		expect(store.contextItem(terminal.id)?.projection).toBe("omitted");
		expect(store.contextItem(tool.id)?.projection).toBe("omitted");

		/** Tool-call blocks still get stripped into a clean clone. */
		const toolCall = manager.record({
			sessionId,
			kind: "assistant",
			payload: {
				role: "assistant",
				content: [
					{ type: "text", text: "calling read" },
					{ type: "toolCall", id: "call-9" },
				],
			},
			tokenCost: 10,
			lifecycle: "active",
			reason: "work",
		});
		const ids = manager.terminalizeTask(sessionId, toolCall.sequence - 1);
		expect(ids).toHaveLength(1);
		expect(ids[0]).not.toBe(toolCall.id);
		expect(store.contextItem(ids[0]!)?.payload).toEqual({
			role: "assistant",
			content: [{ type: "text", text: "calling read" }],
		});
		expect(store.contextItem(toolCall.id)?.lifecycle).toBe("archived");
		store.db.close();
	});

	test("rolls old pre-submission user messages into a replacing summary", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		const users = [
			"first request",
			"second request",
			"third request",
			"fourth request",
			"fifth request",
		].map((content) =>
			manager.record({
				sessionId,
				kind: "user",
				payload: { role: "user", content },
				tokenCost: 10,
				lifecycle: "pinned",
				reason: "user input",
			}),
		);
		const user = (index: number) => users[index]!;

		const first = manager.assembleTask(sessionId, {
			budget: 500,
			target: 400,
			overheadTokens: 0,
			submissionWatermark: user(4).sequence,
			taskStartSequence: user(4).sequence,
			predecessorTerminalIds: [],
		});

		expect(first.evictedIds).toEqual([user(0).id, user(1).id]);
		expect(first.payloads).toContainEqual(
			expect.objectContaining({
				content: expect.stringContaining("first request"),
			}),
		);
		/** The most recent pre-submission messages stay verbatim. */
		expect(first.payloads).toContainEqual({
			role: "user",
			content: "third request",
		});
		expect(first.payloads).toContainEqual({
			role: "user",
			content: "fourth request",
		});
		expect(store.contextItem(user(0).id)?.lifecycle).toBe("archived");
		expect(store.contextItem(user(1).id)?.lifecycle).toBe("archived");

		/** A later task replaces the summary instead of stacking a new one. */
		const sixth = manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "sixth request" },
			tokenCost: 10,
			lifecycle: "pinned",
			reason: "user input",
		});
		const second = manager.assembleTask(sessionId, {
			budget: 500,
			target: 400,
			overheadTokens: 0,
			submissionWatermark: sixth.sequence,
			taskStartSequence: sixth.sequence,
			predecessorTerminalIds: [],
		});

		expect(second.evictedIds).toEqual([user(2).id]);
		const summaries = store
			.contextItems(sessionId)
			.filter((item) => item.reason === ROLLING_SUMMARY_REASON);
		expect(
			summaries.filter((item) => item.lifecycle !== "archived"),
		).toHaveLength(1);
		expect(
			store
				.contextItems(sessionId)
				.some(
					(item) => item.reason === "replaced by rolling summary",
				),
		).toBe(true);
		const live = summaries.find((item) => item.lifecycle !== "archived");
		expect(live?.payload).toEqual(
			expect.objectContaining({
				content: expect.stringContaining("first request"),
			}),
		);
		expect(live?.payload).toEqual(
			expect.objectContaining({
				content: expect.stringContaining("third request"),
			}),
		);
		expect(store.contextItem(user(3).id)?.lifecycle).toBe("pinned");
		expect(store.contextItem(user(2).id)?.lifecycle).toBe("archived");
		store.db.close();
	});

	test("compacts pinned history oldest-first while preserving system content", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "system",
			payload: { role: "system", content: "instructions" },
			tokenCost: 5,
			lifecycle: "pinned",
			reason: "system prompt",
		});
		const old = manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "old request" },
			tokenCost: 50,
			lifecycle: "pinned",
			reason: "user input",
		});
		const recent = manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "newest request" },
			tokenCost: 50,
			lifecycle: "pinned",
			reason: "user input",
		});

		const assembly = manager.assemble(sessionId, {
			budget: 60,
			target: 50,
			overheadTokens: 0,
		});

		expect(assembly.estimatedTokens).toBeLessThanOrEqual(60);
		expect(assembly.evictedIds).toEqual([old.id, recent.id]);
		/** System content is never folded into a summary. */
		expect(store.contextItems(sessionId)[0]).toMatchObject({
			kind: "system",
			lifecycle: "pinned",
		});
		expect(assembly.payloads).toContainEqual(
			expect.objectContaining({
				content: expect.stringContaining("newest request"),
			}),
		);
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
				overheadTokens: 3,
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
				{ budget: 2, target: 2, overheadTokens: 3 },
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

	test("reports history and parked observations alongside the working set", () => {
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
		const evicted = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large output" },
			compactPayload: { role: "toolResult", content: "observation://old" },
			tokenCost: 200,
			compactTokenCost: 5,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read" },
		});
		manager.record({
			sessionId,
			kind: "observation",
			payload: { text: "the externalized output" },
			tokenCost: 200,
			lifecycle: "archived",
			reason: "externalized tool output",
			source: { observationId: "old" },
		});

		const assembly = manager.assemble(sessionId, {
			budget: 100,
			target: 50,
			overheadTokens: 0,
		});
		const inspection = manager.inspect(sessionId, {
			budget: 100,
			target: 50,
		});

		expect(assembly.evictedIds).toEqual([evicted.id]);
		expect(assembly.tokensBefore).toBe(210);
		expect(assembly.tokensAfter).toBe(assembly.estimatedTokens);
		/**
		 * Observations are free against the budget but still count as history.
		 * The pressure note is the working set's only other resident: this
		 * assembly crossed the budget, which is what announces it.
		 */
		expect(inspection.estimatedTokens).toBe(15 + PRESSURE_NOTE_TOKENS);
		expect(inspection.historyTokens).toBe(410 + PRESSURE_NOTE_TOKENS);
		expect(inspection.parkedObservations).toBe(1);
		store.db.close();
	});

	test("carries compaction results through a task assembly", () => {
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
		const evicted = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large output" },
			compactPayload: { role: "toolResult", content: "observation://old" },
			tokenCost: 200,
			compactTokenCost: 5,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read" },
		});

		const assembly = manager.assembleTask(sessionId, {
			budget: 100,
			target: 50,
			overheadTokens: 0,
			submissionWatermark: evicted.sequence,
			taskStartSequence: evicted.sequence,
			predecessorTerminalIds: [],
		});

		expect(assembly.evictedIds).toEqual([evicted.id]);
		expect(assembly.tokensBefore).toBe(210);
		expect(assembly.tokensAfter).toBe(15);
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
			expect(
				store
					.contextItems(sessionId)
					.filter((item) => item.reason !== PRESSURE_NOTE_REASON),
			).toHaveLength(201);
			expect(store.contextItems(sessionId)[0]).toMatchObject({
				lifecycle: "pinned",
				projection: "full",
			});
			store.db.close();
		},
		20_000,
	);

	test("says nothing about pressure while the session stays inside budget", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "small task" },
			tokenCost: 10,
			lifecycle: "pinned",
			reason: "user input",
		});

		const assembly = manager.assemble(sessionId, {
			budget: 100,
			target: 80,
			overheadTokens: 0,
		});

		expect(JSON.stringify(assembly.payloads)).not.toContain(PRESSURE_NOTE);
		expect(
			store
				.contextItems(sessionId)
				.some((item) => item.reason === PRESSURE_NOTE_REASON),
		).toBe(false);
		store.db.close();
	});

	test("announces compaction pressure once, after the pass that caused it", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "keep" },
			tokenCost: 600,
			lifecycle: "pinned",
			reason: "user input",
		});
		const tool = manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large output" },
			compactPayload: { role: "toolResult", content: "observation://old" },
			tokenCost: 500,
			compactTokenCost: 50,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read" },
		});
		const options = { budget: 1_000, target: 800, overheadTokens: 0 };

		const crossing = manager.assemble(sessionId, options);
		const next = manager.assemble(sessionId, options);
		const later = manager.assemble(sessionId, options);

		expect(crossing.evictedIds).toEqual([tool.id]);
		/** The note must not count against the budget it is reporting on. */
		expect(JSON.stringify(crossing.payloads)).not.toContain(PRESSURE_NOTE);
		expect(crossing.estimatedTokens).toBeLessThanOrEqual(options.target);
		expect(
			JSON.stringify(next.payloads).split(PRESSURE_NOTE).length - 1,
		).toBe(1);
		expect(
			JSON.stringify(later.payloads).split(PRESSURE_NOTE).length - 1,
		).toBe(1);
		expect(
			store
				.contextItems(sessionId)
				.filter((item) => item.reason === PRESSURE_NOTE_REASON),
		).toMatchObject([{ lifecycle: "pinned", kind: "pinned-note" }]);
		store.db.close();
	});

	test("reports pressure streak and continuation through the lifecycle sink", () => {
		const store = new SessionStore(storePath());
		const events: Array<Record<string, unknown>> = [];
		const sessionId = store.create();
		const manager = new ContextManager(store, (event) => events.push(event));
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "keep" },
			tokenCost: 600,
			lifecycle: "pinned",
			reason: "user input",
		});
		manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large" },
			compactPayload: { role: "toolResult", content: "ref" },
			tokenCost: 500,
			compactTokenCost: 50,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read" },
		});
		const options = { taskId: "task-1", budget: 1_000, target: 800, overheadTokens: 0 } as const;
		manager.assemble(sessionId, options);
		manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "another large result" },
			compactPayload: { role: "toolResult", content: "another ref" },
			tokenCost: 500,
			compactTokenCost: 50,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read" },
		});
		manager.markAgentProgress("task-1");
		manager.assemble(sessionId, options);
		const assemblies = events.filter((event) => event["type"] === "context.assembly.completed");
		expect(assemblies.map((event) => event["pressureStreak"])).toEqual([1, 2]);
		expect(assemblies[1]?.["agentContinued"]).toBe(true);
		store.db.close();
	});

	test("withholds the pressure note when the budget cannot seat it", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
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
		const options = { budget: 2, target: 2, overheadTokens: 0 };

		const assembly = manager.assemble(sessionId, options);

		/** Pressure was real, but announcing it would have overrun the budget. */
		expect(assembly.evictedIds).toHaveLength(1);
		expect(assembly.estimatedTokens).toBeLessThanOrEqual(options.budget);
		expect(
			store
				.contextItems(sessionId)
				.some((item) => item.reason === PRESSURE_NOTE_REASON),
		).toBe(false);
		store.db.close();
	});

	test("keeps the pressure note out of every eviction path", () => {
		const store = new SessionStore(storePath());
		const sessionId = store.create();
		const manager = new ContextManager(store);
		manager.record({
			sessionId,
			kind: "user",
			payload: { role: "user", content: "keep" },
			tokenCost: 600,
			lifecycle: "pinned",
			reason: "user input",
		});
		const options = { budget: 1_000, target: 800, overheadTokens: 0 };
		/** Weight the retained pass cannot reclaim, so episode eviction runs. */
		manager.record({
			sessionId,
			kind: "assistant",
			payload: { role: "assistant", content: "looked around" },
			tokenCost: 250,
			lifecycle: "active",
			reason: "investigating",
		});
		manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "large output" },
			compactPayload: { role: "toolResult", content: "observation://old" },
			tokenCost: 500,
			compactTokenCost: 50,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "read" },
		});
		const exploration = manager.startEpisode(sessionId, {
			name: "survey",
			kind: "exploration",
		});
		manager.endEpisode(sessionId, "The parser owns validation.");
		const episode = manager.startEpisode(sessionId, {
			name: "sweep",
			kind: "action",
			dependencies: [exploration.id],
		});
		manager.assemble(sessionId, options);
		/**
		 * The note is recorded while the episode is open, so it inherits that
		 * episode id and would ride along on a structural eviction if being
		 * pinned did not exempt it.
		 */
		manager.endEpisode(sessionId);
		manager.record({
			sessionId,
			kind: "tool-result",
			payload: { role: "toolResult", content: "more output" },
			tokenCost: 200,
			lifecycle: "retained",
			reason: "consumed",
			source: { toolName: "bash" },
		});

		const assembly = manager.assemble(sessionId, options);

		/** Vacuous unless the episode holding the note was actually swept. */
		expect(assembly.episodesArchived).toBe(1);
		expect(JSON.stringify(assembly.payloads)).toContain(PRESSURE_NOTE);
		expect(
			store
				.contextItems(sessionId)
				.find((item) => item.reason === PRESSURE_NOTE_REASON),
		).toMatchObject({ lifecycle: "pinned", episodeId: episode.id });
		store.db.close();
	});
});
