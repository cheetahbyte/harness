import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextManager } from "../src/context-manager";
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
});
