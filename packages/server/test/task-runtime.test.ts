import { describe, expect, test } from "bun:test";
import {
	CapabilityCatalog,
	type CapabilitySnapshot,
} from "../src/capabilities/catalog";
import { CapabilityContext } from "../src/capabilities/context";
import {
	ConfirmationRequiredError,
	TaskRuntime,
} from "../src/task-runtime";
import { TaskScheduler } from "../src/sessions/scheduler";

function snapshot(
	confirmation: "none" | "confirm_once" | "confirm_each" = "none",
) {
	return new CapabilityCatalog(
		[
			{
				kind: "tool",
				id: "tool:read",
				name: "read",
				description: "Read files",
				providerDisplayName: "Workspace",
				metadataTrust: "harnez",
				providerBinding: {
					providerId: "workspace",
					bindingGeneration: "one",
				},
				schema: {},
				effect: "read_only",
			},
			{
				kind: "tool",
				id: "tool:write",
				name: "write",
				description: "Write files",
				providerDisplayName: "Workspace",
				metadataTrust: "harnez",
				providerBinding: {
					providerId: "workspace",
					bindingGeneration: "one",
				},
				schema: {},
				effect: "mutating",
			},
		],
		"catalog-one",
	).snapshot({
		tool: { maxLevel: "execute", confirmation },
		skill: { maxLevel: "none" },
	});
}

function runtime(
	capabilities = snapshot(),
	options: ConstructorParameters<typeof TaskRuntime>[3] = {},
) {
	const task = new TaskRuntime(
		capabilities,
		new CapabilityContext({}, (_base, items) => items),
		new TextEncoder().encode("test-evidence-key"),
		{ cancellationGraceMs: 0, ...options },
	);
	for (const item of capabilities.list({ kind: "tool", limit: 100 }).items)
		task.load(item.ref);
	return task;
}

function ref(capabilities: CapabilitySnapshot, id: string) {
	const found = capabilities.list({ limit: 100 }).items.find((item) => item.ref.id === id)?.ref;
	if (!found) throw new Error(`missing ${id}`);
	return found;
}

describe("TaskRuntime", () => {
	test("tracks source coverage across overlapping reads", () => {
		const task = runtime();
		expect(task.recordSourceRead("obs-1", 10, [[0, 2]], [4, 6])).toEqual({
			sourceId: "obs-1",
			totalCharacters: 10,
			readRanges: [[0, 2], [4, 6]],
			unreadRanges: [[2, 4], [6, 10]],
		});
		expect(task.recordSourceRead("obs-1", 10, [], [2, 10]).unreadRanges).toEqual([]);
		expect(task.recordSourceRead("obs-1", 10, [], [4, 6]).readRanges).toEqual([[0, 10]]);
		expect(task.ledger().filter((entry) => entry.type === "source_range_read")).toHaveLength(2);
	});

	test("records redacted HMAC evidence and a terminal call outcome", async () => {
		const task = runtime();
		await task.execute(
			ref(task.snapshot, "tool:write"),
			{ password: "do-not-store", path: "note.txt" },
			{ execute: async () => ({ token: "also-secret", ok: true }) },
		);
		task.finish({ status: "completed", terminalMessageIds: ["message-1"] });
		const serialized = JSON.stringify(task.ledger());
		expect(serialized).not.toContain("do-not-store");
		expect(serialized).not.toContain("also-secret");
		expect(task.digest(task.snapshot)).toMatchObject({
			status: "completed",
			capabilityCalls: 1,
			successfulMutatingCalls: 1,
		});
	});

	test("resolves confirmations inside the existing execute ceiling", async () => {
		const task = runtime(snapshot("confirm_once"));
		const capability = ref(task.snapshot, "tool:read");
		let confirmation: ConfirmationRequiredError | undefined;
		try {
			await task.execute(capability, {}, { execute: async () => "ok" });
		} catch (error) {
			if (error instanceof ConfirmationRequiredError) confirmation = error;
		}
		if (!confirmation) throw new Error("missing confirmation request");
		task.confirm(confirmation.callId);
		expect(
			await task.execute(capability, {}, { execute: async () => "ok" }, {
				confirmationId: confirmation.callId,
			}),
		).toBe("ok");
		expect(await task.execute(capability, {}, { execute: async () => "again" })).toBe("again");
	});

	test("does not apply one capability confirmation to another capability", async () => {
		const task = runtime(snapshot("confirm_each"));
		const read = ref(task.snapshot, "tool:read");
		const write = ref(task.snapshot, "tool:write");
		let confirmation: ConfirmationRequiredError | undefined;
		try {
			await task.execute(read, {}, { execute: async () => "read" });
		} catch (error) {
			if (error instanceof ConfirmationRequiredError) confirmation = error;
		}
		if (!confirmation) throw new Error("missing confirmation request");
		task.confirm(confirmation.callId);
		await expect(
			task.execute(write, {}, { execute: async () => "write" }, {
				confirmationId: confirmation.callId,
			}),
		).rejects.toBeInstanceOf(ConfirmationRequiredError);
		expect(
			await task.execute(read, {}, { execute: async () => "read" }, {
				confirmationId: confirmation.callId,
			}),
		).toBe("read");
	});

	test("closes cancellation with unknown outcome before superseding", async () => {
		const task = runtime();
		const pending = task.execute(
			ref(task.snapshot, "tool:write"),
			{},
			{ execute: async () => await new Promise(() => {}) },
		);
		const result = await task.cancel("superseded");
		expect(result.status).toBe("superseded");
		expect(task.state).toBe("terminal");
		expect(task.digest(task.snapshot).unknownMutatingCalls).toBe(1);
		expect(task.context.items()).toEqual([]);
		void pending;
	});

	test("joins concurrent cancellation while a capability call is in flight", async () => {
		const task = runtime();
		let markStarted!: () => void;
		let markAborted!: () => void;
		const started = new Promise<void>((resolve) => (markStarted = resolve));
		const aborted = new Promise<void>((resolve) => (markAborted = resolve));
		const pending = task.execute(
			ref(task.snapshot, "tool:write"),
			{},
			{
				execute: async (_input, signal) => {
					markStarted();
					signal.addEventListener("abort", markAborted, { once: true });
					return await new Promise(() => {});
				},
			},
		);
		await started;
		const first = task.cancel("cancelled", ["cancelled-message"]);
		const second = task.cancel("superseded", ["superseded-message"]);
		expect(first).toBe(second);
		await aborted;
		const [one, two] = await Promise.all([first, second]);
		expect(one).toEqual({
			status: "cancelled",
			terminalMessageIds: ["cancelled-message"],
		});
		expect(two).toEqual(one);
		expect(
			task.ledger().filter((entry) => entry.type === "cancellation_requested"),
		).toHaveLength(1);
		expect(
			task
				.ledger()
				.filter((entry) => entry.type === "capability_call_finished"),
		).toHaveLength(1);
		expect(task.state).toBe("terminal");
		void pending;
	});

	test("holds successor mutations until unknown effects are acknowledged", async () => {
		const task = runtime(snapshot(), { unknownPriorMutatingEffects: true });
		const capability = ref(task.snapshot, "tool:write");
		await expect(
			task.execute(capability, {}, { execute: async () => "write" }),
		).rejects.toThrow("ACKNOWLEDGEMENT_REQUIRED");
		task.acknowledgeUnknownPriorEffects();
		expect(
			await task.execute(capability, {}, { execute: async () => "write" }),
		).toBe("write");
	});
});

describe("TaskScheduler", () => {
	test("distinguishes default queue order from success dependency", () => {
		const ordinary = new TaskScheduler();
		const active = runtime(snapshot(), { id: "first" });
		ordinary.activate(active);
		ordinary.enqueue({ id: "next", text: "next" }, 3);
		active.finish({
			status: "failed",
			error: { code: "FAILED", message: "no" },
			terminalMessageIds: [],
		});
		expect(ordinary.settle(active)).toMatchObject({
			state: "ready",
			queued: { id: "next" },
			predecessor: { id: "first" },
		});

		const dependent = new TaskScheduler();
		const first = runtime(snapshot(), { id: "first" });
		dependent.activate(first);
		dependent.enqueue({ id: "blocked", text: "blocked" }, 3, {
			requirePredecessorSuccess: true,
		});
		first.finish({ status: "cancelled", terminalMessageIds: [] });
		expect(dependent.settle(first)).toMatchObject({
			state: "blocked",
			queued: { id: "blocked" },
		});
	});

	test("binds success dependency to the recorded predecessor", () => {
		const queue = new TaskScheduler();
		const first = runtime(snapshot(), { id: "first" });
		queue.activate(first);
		queue.enqueue({ id: "ordinary", text: "ordinary" }, 1);
		queue.enqueue({ id: "dependent", text: "dependent" }, 1, {
			requirePredecessorSuccess: true,
		});
		first.finish({ status: "completed", terminalMessageIds: ["terminal-a"] });
		const ordinary = queue.settle(first);
		if (ordinary?.state !== "ready") throw new Error("missing ordinary task");
		const second = runtime(snapshot(), { id: ordinary.queued.id });
		queue.activate(second);
		second.finish({
			status: "failed",
			error: { code: "FAILED", message: "failed" },
			terminalMessageIds: [],
		});
		const dependent = queue.settle(second);
		expect(dependent).toMatchObject({
			state: "ready",
			queued: { id: "dependent" },
			predecessor: { id: "first" },
		});
	});

	test("recovers a blocked head by resume, cancel, or replacement", () => {
		const setup = () => {
			const queue = new TaskScheduler();
			const first = runtime(snapshot(), { id: "first" });
			queue.activate(first);
			queue.enqueue({ id: "blocked", text: "blocked" }, 1, {
				requirePredecessorSuccess: true,
			});
			queue.enqueue({ id: "after", text: "after" }, 1);
			first.finish({ status: "cancelled", terminalMessageIds: [] });
			queue.settle(first);
			return queue;
		};

		const resumed = setup();
		resumed.resume("blocked");
		expect(resumed.next()).toMatchObject({
			state: "ready",
			queued: { id: "blocked" },
		});

		const cancelled = setup();
		expect(cancelled.cancelQueued("blocked").id).toBe("blocked");
		expect(cancelled.next()).toMatchObject({
			state: "ready",
			queued: { id: "after" },
		});

		const replaced = setup();
		expect(
			replaced.replaceQueued(
				"blocked",
				{ id: "replacement", text: "replacement" },
				2,
			).cancelled.id,
		).toBe("blocked");
		expect(replaced.next()).toMatchObject({
			state: "ready",
			queued: { id: "replacement", userInput: { text: "replacement" } },
		});
	});

	test("preserves queued images when a blocked task is resumed", () => {
		const queue = new TaskScheduler();
		const active = runtime(snapshot(), { id: "first" });
		const images = [{ id: "image-1", mimeType: "image/png" as const, data: "iVBORw0KGgo=" }];
		queue.activate(active);
		queue.enqueue({ id: "blocked", text: "with image", images }, 1, { requirePredecessorSuccess: true });
		active.finish({ status: "cancelled", terminalMessageIds: [] });
		queue.settle(active);
		queue.resume("blocked");
		expect(queue.next()).toMatchObject({ state: "ready", queued: { userInput: { text: "with image", images } } });
	});

	test("prioritizes the latest supersede replacement", () => {
		const queue = new TaskScheduler();
		const active = runtime(snapshot(), { id: "first" });
		queue.activate(active);
		queue.enqueue({ id: "later", text: "later" }, 1);
		queue.requestSupersede(
			active.id,
			{ id: "replacement-1", text: "one" },
			2,
		);
		const latest = queue.requestSupersede(
			active.id,
			{ id: "replacement-2", text: "two" },
			3,
		);
		expect(latest.replaced?.id).toBe("replacement-1");
		active.finish({ status: "superseded", terminalMessageIds: [] });
		expect(queue.settle(active)).toMatchObject({
			state: "ready",
			queued: { id: "replacement-2", kind: "supersede" },
		});
	});
});
