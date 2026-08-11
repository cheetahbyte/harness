import type { ModelConfig, ServerEvent } from "../../shared/src/protocol";
import type { HarnessAgentRuntime } from "./agent/runtime";
import {
	CapabilityCatalog,
	type CapabilitySnapshot,
} from "./capabilities/catalog";
import {
	CapabilityContext,
	type TokenAccountant,
} from "./capabilities/context";
import type { ContextManager } from "./context/manager";
import { log } from "./logger";
import type { SessionStore } from "./session-store";
import { activateSkill, type SkillSnapshotEntry, scanSkills } from "./skills";
import { TaskRuntime, type TaskTerminalStatus } from "./task-runtime";
import type {
	QueuedTask,
	SchedulerDecision,
	TaskScheduler,
} from "./task-scheduler";
import { tokenCost } from "./token-cost";
import { CoreTools } from "./tools";

export type PendingSteer = {
	id: string;
	type: "steer";
	text: string;
};

export type RunningTask = {
	controller: AbortController;
	task: TaskRuntime;
	tools: CoreTools;
	skills: SkillSnapshotEntry[];
	prompt: string;
	contextWatermark: number;
};

export type TaskSession = {
	starting?: Promise<void>;
	running?: RunningTask;
	scheduler: TaskScheduler;
	pendingSteer?: PendingSteer;
};

type RunnerOptions = {
	runtime: HarnessAgentRuntime;
	store: SessionStore;
	context: ContextManager;
	capabilityBudget: number;
	workspace: (sessionId: string) => string;
	modelConfig: (sessionId: string) => ModelConfig | undefined;
	emit: (sessionId: string, event: ServerEvent) => void;
};

type RunInput = {
	id: string;
	session: TaskSession;
	command: string | QueuedTask | PendingSteer;
	predecessor?: TaskRuntime;
	resume?: RunningTask;
};

export class SessionTaskRunner {
	constructor(private readonly options: RunnerOptions) {}

	async run(input: RunInput): Promise<void> {
		const { id, session, command, predecessor, resume } = input;
		if (session.running) return;
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending = typeof command === "string" ? undefined : command;
		const text = commandText(command);
		const pendingType = pendingCommandType(pending);
		const running = resume
			? this.resumeTask(session, resume, controller, text)
			: await this.startTask({
					id,
					session,
					text,
					controller,
					...(predecessor ? { predecessor } : {}),
					...(pending && "submissionWatermark" in pending
						? { submissionWatermark: pending.submissionWatermark }
						: {}),
				});
		this.emitStart(id, running, pending, pendingType);
		try {
			await this.options.runtime.run({
				sessionId: id,
				text: running.prompt,
				config: this.options.modelConfig(id),
				tools: running.tools,
				task: running.task,
				skills: running.skills,
				signal: controller.signal,
				emit: (event) => this.options.emit(id, event),
			});
		} catch (error) {
			await this.fail(id, session, running, pending, error);
			return;
		}
		delete session.running;
		if (controller.signal.aborted) {
			await this.abort(id, session, running, pending, startedAt);
			return;
		}
		this.succeed(id, running, pending, startedAt);
		await this.advance(id, session, session.scheduler.settle(running.task));
	}

	async advance(
		id: string,
		session: TaskSession,
		decision: SchedulerDecision | undefined,
	): Promise<void> {
		const steer = session.pendingSteer;
		delete session.pendingSteer;
		if (steer) return this.run({ id, session, command: steer });
		if (!decision) return;
		if (decision.state === "blocked") {
			this.options.emit(id, {
				type: "task-state",
				taskId: decision.queued.id,
				state: "blocked",
			});
			return;
		}
		await this.run({
			id,
			session,
			command: decision.queued,
			...(decision.predecessor ? { predecessor: decision.predecessor } : {}),
		});
	}

	private resumeTask(
		session: TaskSession,
		resume: RunningTask,
		controller: AbortController,
		prompt: string,
	): RunningTask {
		const running = { ...resume, controller, prompt };
		session.running = running;
		session.scheduler.activate(running.task);
		return running;
	}

	private async startTask(
		input: Omit<RunInput, "command" | "resume"> & {
			text: string;
			controller: AbortController;
			submissionWatermark?: number;
		},
	): Promise<RunningTask> {
		let releaseStarting!: () => void;
		input.session.starting = new Promise<void>(
			(resolve) => (releaseStarting = resolve),
		);
		try {
			const running = await this.createTask(input);
			input.session.running = running;
			input.session.scheduler.activate(running.task);
			return running;
		} finally {
			delete input.session.starting;
			releaseStarting();
		}
	}

	private emitStart(
		id: string,
		running: RunningTask,
		pending: QueuedTask | PendingSteer | undefined,
		pendingType: QueuedTask["kind"] | PendingSteer["type"] | undefined,
	): void {
		if (pending)
			this.options.emit(id, {
				type: "command",
				id: pending.id,
				command: pendingType ?? "follow-up",
				state: "started",
			});
		this.options.emit(id, { type: "status", text: "running" });
		this.options.emit(id, {
			type: "task-state",
			taskId: running.task.id,
			state: "running",
		});
		log.info(
			{
				sessionId: id,
				provider: this.options.modelConfig(id)?.provider,
				model: this.options.modelConfig(id)?.model,
				command: pendingType ?? "prompt",
				textLength: running.prompt.length,
			},
			"run started",
		);
	}

	private async fail(
		id: string,
		session: TaskSession,
		running: RunningTask,
		pending: QueuedTask | PendingSteer | undefined,
		error: unknown,
	): Promise<void> {
		log.error({ err: error, sessionId: id }, "run failed");
		const message = error instanceof Error ? error.message : String(error);
		this.options.emit(id, { type: "error", message });
		const terminalMessageIds = this.terminalMessages(id, running);
		if (!running.task.result())
			running.task.finish({
				status: "failed",
				error: { code: "TASK_FAILED", message },
				terminalMessageIds,
			});
		else running.task.addTerminalMessageIds(terminalMessageIds);
		delete session.running;
		this.completeTask(
			id,
			running.task,
			running.task.result()?.status ?? "failed",
		);
		this.finishPending(id, pending);
		await this.advance(id, session, session.scheduler.settle(running.task));
	}

	private async abort(
		id: string,
		session: TaskSession,
		running: RunningTask,
		pending: QueuedTask | PendingSteer | undefined,
		startedAt: number,
	): Promise<void> {
		const steer = session.pendingSteer;
		if (
			steer &&
			!session.scheduler.hasPendingSupersede() &&
			!running.task.result()
		) {
			delete session.pendingSteer;
			this.options.emit(id, { type: "aborted" });
			await this.run({ id, session, command: steer, resume: running });
			return;
		}
		const terminalMessageIds = this.terminalMessages(id, running);
		if (!running.task.result())
			await running.task.cancel(
				session.scheduler.hasPendingSupersede() ? "superseded" : "cancelled",
				terminalMessageIds,
			);
		else running.task.addTerminalMessageIds(terminalMessageIds);
		log.info(
			{ sessionId: id, durationMs: Date.now() - startedAt },
			"run aborted",
		);
		this.options.emit(id, { type: "aborted" });
		this.completeTask(
			id,
			running.task,
			running.task.result()?.status ?? "cancelled",
		);
		this.finishPending(id, pending);
		await this.advance(id, session, session.scheduler.settle(running.task));
	}

	private succeed(
		id: string,
		running: RunningTask,
		pending: QueuedTask | PendingSteer | undefined,
		startedAt: number,
	): void {
		running.task.finish({
			status: "completed",
			terminalMessageIds: this.terminalMessages(id, running),
		});
		const durationMs = Date.now() - startedAt;
		log.info({ sessionId: id, durationMs }, "run finished");
		this.options.emit(id, { type: "completed", durationMs });
		this.completeTask(id, running.task, "completed");
		this.finishPending(id, pending);
	}

	private terminalMessages(id: string, running: RunningTask): string[] {
		return this.options.context.terminalizeTask(id, running.contextWatermark);
	}

	private async createTask({
		id,
		text,
		controller,
		predecessor,
		submissionWatermark,
	}: {
		id: string;
		text: string;
		controller: AbortController;
		predecessor?: TaskRuntime;
		submissionWatermark?: number;
	}): Promise<RunningTask> {
		const bindingGeneration = crypto.randomUUID();
		const contextWatermark = this.contextSequence(id);
		const tools = new CoreTools(this.options.workspace(id));
		const scanned = await scanSkills(
			this.options.workspace(id),
			undefined,
			bindingGeneration,
		);
		const catalog = new CapabilityCatalog(
			[
				...tools.capabilities(bindingGeneration),
				...scanned.discoverable.map(({ capability }) => capability),
			],
			bindingGeneration,
		);
		const snapshot = catalog.snapshot({
			tool: { maxLevel: "execute", confirmation: "none" },
			skill: { maxLevel: "activate" },
		});
		const { task, context, accountant } = this.createRuntime({
			id,
			text,
			snapshot,
			contextWatermark,
			...(predecessor ? { predecessor } : {}),
			...(submissionWatermark === undefined ? {} : { submissionWatermark }),
		});
		this.loadTools(task, snapshot, context, accountant);
		const { prompt, selected } = selectedSkills(text, scanned.discoverable);
		await this.activateSkills(selected, snapshot, context, accountant);
		return {
			controller,
			task,
			tools,
			skills: scanned.discoverable,
			prompt,
			contextWatermark,
		};
	}

	private createRuntime({
		id,
		text,
		snapshot,
		contextWatermark,
		predecessor,
		submissionWatermark,
	}: {
		id: string;
		text: string;
		snapshot: CapabilitySnapshot;
		contextWatermark: number;
		predecessor?: TaskRuntime;
		submissionWatermark?: number;
	}): {
		task: TaskRuntime;
		context: CapabilityContext;
		accountant: TokenAccountant;
	} {
		const predecessorDigest = predecessor?.digest(snapshot);
		const context = new CapabilityContext(
			{
				model: this.options.modelConfig(id),
				userInput: text,
				...(predecessorDigest ? { predecessorDigest } : {}),
			},
			(base, items) => ({
				base,
				capabilityContext: items.map(({ content }) => content),
			}),
			this.options.capabilityBudget,
			512,
		);
		const task = new TaskRuntime(
			snapshot,
			context,
			crypto.getRandomValues(new Uint8Array(32)),
			{
				unknownPriorMutatingEffects:
					(predecessorDigest?.unknownMutatingCalls ?? 0) > 0,
				...(predecessorDigest ? { predecessorDigest } : {}),
				submissionWatermark: submissionWatermark ?? contextWatermark,
				taskStartSequence: contextWatermark,
				predecessorTerminalMessageIds:
					predecessor?.result()?.terminalMessageIds ?? [],
			},
		);
		const accountant = {
			modelId: this.options.modelConfig(id)?.model ?? "unconfigured",
			serializerVersion: "pi-json-v1",
			method: "conservative_estimate" as const,
			count: (request: unknown) => tokenCost(request),
		};
		return { task, context, accountant };
	}

	private loadTools(
		task: TaskRuntime,
		snapshot: CapabilitySnapshot,
		context: CapabilityContext,
		accountant: TokenAccountant,
	): void {
		for (const item of snapshot.list({ kind: "tool", limit: 100 }).items) {
			const inspected = snapshot.inspect(item.ref);
			const admission = context.admit({
				capability: item.ref,
				scope: "task",
				contentHash: item.ref.contractHash,
				content: inspected.contract,
				accountant,
			});
			if (admission.status === "rejected")
				throw new Error(JSON.stringify(admission));
			task.load(item.ref);
		}
	}

	private async activateSkills(
		selected: readonly SkillSnapshotEntry[],
		snapshot: CapabilitySnapshot,
		context: CapabilityContext,
		accountant: TokenAccountant,
	): Promise<void> {
		for (const entry of selected) {
			const ref = snapshot.reference(entry.capability.id);
			const admission = await activateSkill(entry, ref, context, accountant);
			if (admission.status === "rejected")
				throw new Error(JSON.stringify(admission));
		}
	}

	private completeTask(
		id: string,
		task: TaskRuntime,
		status: TaskTerminalStatus,
	): void {
		this.options.runtime.forget(id);
		this.options.store.appendTaskLedger(id, task.id, task.ledger());
		this.options.store.recordTaskTerminal(id, task.id, status, task.startedAt);
		this.options.emit(id, {
			type: "task-state",
			taskId: task.id,
			state: "terminal",
			status,
		});
	}

	private finishPending(
		id: string,
		pending: QueuedTask | PendingSteer | undefined,
	): void {
		if (!pending) return;
		this.options.emit(id, {
			type: "command",
			id: pending.id,
			command: "kind" in pending ? pending.kind : pending.type,
			state: "finished",
		});
	}

	private contextSequence(id: string): number {
		return this.options.store.contextItems(id).at(-1)?.sequence ?? 0;
	}
}

function commandText(command: string | QueuedTask | PendingSteer): string {
	if (typeof command === "string") return command;
	return "userInput" in command ? command.userInput.text : command.text;
}

function pendingCommandType(
	pending: QueuedTask | PendingSteer | undefined,
): QueuedTask["kind"] | PendingSteer["type"] | undefined {
	if (!pending) return undefined;
	return "kind" in pending ? pending.kind : pending.type;
}

function selectedSkills(
	text: string,
	discoverable: readonly SkillSnapshotEntry[],
): { prompt: string; selected: SkillSnapshotEntry[] } {
	const names = new Set<string>();
	const prompt = text
		.replace(
			/(^|\s)\/([a-z0-9-]+)(?=$|\s|[.,!?;:])/g,
			(match, prefix: string, name: string) => {
				if (discoverable.some((entry) => entry.capability.name === name)) {
					names.add(name);
					return prefix;
				}
				return match;
			},
		)
		.trim();
	return {
		prompt,
		selected: [...names].flatMap((name) => {
			const entry = discoverable.find(
				(candidate) => candidate.capability.name === name,
			);
			return entry ? [entry] : [];
		}),
	};
}
