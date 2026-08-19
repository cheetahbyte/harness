import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CredentialStore } from "@earendil-works/pi-ai";

import { managedMessages } from "../src/agent/events";
import { HarnezAgentRuntime } from "../src/agent/runtime";
import { ContextManager } from "../src/context/manager";
import { SessionStore } from "../src/sessions/store";

/**
 * The capability ceiling used to be an 8k literal compiled into the server,
 * which put every skill larger than a few pages permanently out of reach no
 * matter how much room the model actually had. It has to follow the model.
 */

const paths: string[] = [];

afterEach(() => {
	while (paths.length) {
		const path = paths.pop();
		if (path) rmSync(path, { recursive: true, force: true });
	}
});

function runtime(model?: { contextWindow: number; maxTokens: number }) {
	const dir = mkdtempSync(join(tmpdir(), "harnez-budget-"));
	paths.push(dir);
	const store = new SessionStore(join(dir, "state.sqlite"));
	const sessionId = store.create(dir);
	const models = {
		getModel: () =>
			model
				? { id: "model-1", name: "Model 1", provider: "fake", ...model }
				: undefined,
	};
	return {
		sessionId,
		agentRuntime: new HarnezAgentRuntime({
			credentials: {} as CredentialStore,
			modelsFor: () => models as never,
			store,
			context: new ContextManager(store),
		}),
	};
}

test("the capability budget scales with the model's usable input window", () => {
	const { sessionId, agentRuntime } = runtime({
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
	// The model's usable input window is the ceiling; Harnez adds no smaller default.
	expect(
		agentRuntime.capabilityBudget(sessionId, {
			provider: "fake",
			model: "model-1",
		}),
	).toBe(168_000);
});

test("a small model narrows the budget rather than overcommitting it", () => {
	const { sessionId, agentRuntime } = runtime({
		contextWindow: 32_000,
		maxTokens: 4_000,
	});
	expect(
		agentRuntime.capabilityBudget(sessionId, {
			provider: "fake",
			model: "model-1",
		}),
	).toBe(28_000);
});

test("a resolved model is never widened to the fallback ceiling", () => {
	const { sessionId, agentRuntime } = runtime({
		contextWindow: 7_000,
		maxTokens: 2_000,
	});
	expect(
		agentRuntime.capabilityBudget(sessionId, {
			provider: "fake",
			model: "model-1",
		}),
	).toBe(5_000);
});

test("an unconfigured or unresolvable model falls back to the fixed ceiling", () => {
	const { sessionId, agentRuntime } = runtime();
	expect(agentRuntime.capabilityBudget(sessionId, undefined)).toBe(8_000);
	expect(
		agentRuntime.capabilityBudget(sessionId, {
			provider: "fake",
			model: "missing",
		}),
	).toBe(8_000);
});

test("capability content consumes the transcript budget", () => {
	const dir = mkdtempSync(join(tmpdir(), "harnez-shared-budget-"));
	paths.push(dir);
	const store = new SessionStore(join(dir, "state.sqlite"));
	const sessionId = store.create(dir);
	const context = new ContextManager(store);
	const user = context.record({
		sessionId,
		kind: "user",
		payload: { role: "user", content: "u".repeat(320) },
		tokenCost: 80,
		lifecycle: "pinned",
		reason: "user input",
	});
	const task = {
		context: {
			items: () => [
				{
					capability: { id: "skill:large" },
					content: "s".repeat(160),
				},
			],
		},
		startedAt: new Date().toISOString(),
	};

	const messages = managedMessages({
		sessionId,
		model: {} as never,
		task: task as never,
		store,
		context,
		contextOptions: () => ({ budget: 100, target: 80, overheadTokens: 0 }),
	});

	expect(store.contextItem(user.id)?.lifecycle).toBe("archived");
	expect(messages).toContainEqual(
		expect.objectContaining({
			role: "user",
			content: [
				expect.objectContaining({
					text: expect.stringContaining("Task capability context"),
				}),
			],
		}),
	);
	store.db.close();
});

test("a skill the old 8k ceiling refused now fits", () => {
	const { sessionId, agentRuntime } = runtime({
		contextWindow: 205_000,
		maxTokens: 32_000,
	});
	// The reported failure: a ~29.6KB skill body plus the core tool contracts
	// already admitted, estimated at 7820 tokens against the old 8k ceiling.
	const observed = 7_820;
	const budget = agentRuntime.capabilityBudget(sessionId, {
		provider: "fake",
		model: "model-1",
	});
	expect(observed + 512).toBeGreaterThan(8_000);
	expect(observed + 512).toBeLessThan(budget);
});
