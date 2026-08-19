import type {
	ImageAttachment,
	ModelConfig,
	ServerEvent,
} from "../../../shared/src/protocol";
import { displayUserInput } from "../../../shared/src/protocol";
import { slashCommandPattern } from "../../../shared/src/slash-command";
import type { AgentRunTiming, HarnezAgentRuntime } from "../agent/runtime";
import { contextCapabilities } from "../agent/tools";
import {
	CapabilityCatalog,
	type CapabilitySnapshot,
} from "../capabilities/catalog";
import {
	CapabilityContext,
	describeRejection,
	type TokenAccountant,
} from "../capabilities/context";
import type { ContextManager } from "../context/manager";
import { ContextBudgetError } from "../context/types";
import { log } from "../logger";
import { isMcpProvider, mcpCapabilities } from "../mcp/capabilities";
import type { McpRegistry, McpToolDescriptor } from "../mcp/registry";
import { expandPrompt, scanPrompts } from "../prompts";
import { activateSkill, type SkillSnapshotEntry, scanSkills } from "../skills";
import { TaskRuntime, type TaskTerminalStatus } from "../task-runtime";
import type { RuntimeEventSink } from "../telemetry/events";
import { tokenCost } from "../token-cost";
import { CoreTools } from "../tools";
import type { QueuedTask, SchedulerDecision } from "./scheduler";
import type { Session } from "./session";
import type { SessionStore } from "./store";

export type PendingSteer = {
	id: string;
	type: "steer";
	text: string;
	images?: ImageAttachment[];
};
export type InitialInput = { text: string; images?: ImageAttachment[] };

export type RunningTask = {
	controller: AbortController;
	task: TaskRuntime;
	tools: CoreTools;
	skills: SkillSnapshotEntry[];
	mcpTools: McpToolDescriptor[];
	/** The workspace's registry, kept for the calls this task's tools make. */
	mcp: Pick<McpRegistry, "call">;
	prompt: string;
	contextWatermark: number;
};

type RunnerOptions = {
	runtime: HarnezAgentRuntime;
	store: SessionStore;
	context: ContextManager;
	/** Per workspace: two sessions in different projects see different servers. */
	mcpFor: (sessionId: string) => Pick<McpRegistry, "snapshot" | "call">;
	workspace: (sessionId: string) => string;
	modelConfig: (sessionId: string) => ModelConfig | undefined;
	emit: (sessionId: string, event: ServerEvent) => void;
	sink?: RuntimeEventSink;
};

type RunInput = {
	id: string;
	session: Session;
	command: string | InitialInput | QueuedTask | PendingSteer;
	predecessor?: TaskRuntime;
	resume?: RunningTask;
};

export class SessionTaskRunner {
	private readonly turnIds = new Map<string, number>();
	private readonly startedTasks = new Set<string>();
	constructor(private readonly options: RunnerOptions) {}

	async run(input: RunInput): Promise<void> {
		const { id, session, command, predecessor, resume } = input;
		if (session.running) return;
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending =
			typeof command === "string" || isInitialInput(command)
				? undefined
				: command;
		const text = commandText(command);
		const images = commandImages(command);
		const pendingType = pendingCommandType(pending);
		const running = resume
			? this.resumeTask(session, resume, controller, text)
			: await this.startTask({
					id,
					session,
					text,
					images,
					controller,
					...(predecessor ? { predecessor } : {}),
					...(pending && "submissionWatermark" in pending
						? { submissionWatermark: pending.submissionWatermark }
						: {}),
				});
		this.emitStart(id, running, pending, pendingType, text, images);
		if (!this.startedTasks.has(running.task.id))
			this.options.sink?.({
				type: "task.started",
				timestamp: new Date().toISOString(),
				sessionId: id,
				taskId: running.task.id,
			});
		this.startedTasks.add(running.task.id);
		const turnId =
			(this.turnIds.set(id, (this.turnIds.get(id) ?? 0) + 1),
			this.turnIds.get(id)!);
		this.options.sink?.({
			type: "turn.started",
			timestamp: new Date().toISOString(),
			sessionId: id,
			taskId: running.task.id,
			turnId,
		});
		let timing: AgentRunTiming;
		try {
			timing = await this.options.runtime.run({
				sessionId: id,
				text: running.prompt,
				...(images.length ? { images } : {}),
				config: this.options.modelConfig(id),
				tools: running.tools,
				task: running.task,
				skills: running.skills,
				mcpTools: running.mcpTools,
				mcp: running.mcp,
				signal: controller.signal,
				emit: (event) => this.options.emit(id, event),
				turnId,
			});
		} catch (error) {
			this.options.sink?.({
				type: "turn.completed",
				timestamp: new Date().toISOString(),
				sessionId: id,
				taskId: running.task.id,
				turnId,
				status: "failed",
				durationMs: Date.now() - startedAt,
			});
			await this.fail(id, session, running, pending, error, startedAt);
			return;
		}
		delete session.running;
		if (controller.signal.aborted) {
			this.options.sink?.({
				type: "turn.completed",
				timestamp: new Date().toISOString(),
				sessionId: id,
				taskId: running.task.id,
				turnId,
				status: "cancelled",
				durationMs: Date.now() - startedAt,
			});
			await this.abort(id, session, running, pending, startedAt, timing);
			return;
		}
		this.succeed(id, running, pending, startedAt, timing);
		this.options.sink?.({
			type: "turn.completed",
			timestamp: new Date().toISOString(),
			sessionId: id,
			taskId: running.task.id,
			turnId,
			durationMs: Date.now() - startedAt,
		});
		this.options.sink?.({
			type: "task.completed",
			timestamp: new Date().toISOString(),
			sessionId: id,
			taskId: running.task.id,
			status: "completed",
			durationMs: Date.now() - startedAt,
		});
		await this.advance(id, session, session.scheduler.settle(running.task));
	}

	async advance(
		id: string,
		session: Session,
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
		session: Session,
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
			images: ImageAttachment[];
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
		text: string,
		images: ImageAttachment[],
	): void {
		this.options.emit(id, {
			type: "user",
			text: displayText(text, images),
			...(pending ? { id: pending.id } : {}),
		});
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
		session: Session,
		running: RunningTask,
		pending: QueuedTask | PendingSteer | undefined,
		error: unknown,
		startedAt: number,
	): Promise<void> {
		log.error({ err: error, sessionId: id }, "run failed");
		this.options.sink?.({
			type: "task.completed",
			timestamp: new Date().toISOString(),
			sessionId: id,
			taskId: running.task.id,
			status: "failed",
			durationMs: Date.now() - startedAt,
		});
		const message = error instanceof Error ? error.message : String(error);
		/**
		 * The budget cliff is the one failure the user can act on, and it is the
		 * only place compaction cannot help: protected content alone overflows.
		 * It gets its own event so clients can say that instead of showing it as
		 * an indistinguishable provider error.
		 */
		this.options.emit(
			id,
			error instanceof ContextBudgetError
				? {
						type: "context-budget-error",
						estimatedTokens: error.estimatedTokens,
						budget: error.budget,
						code: error.code,
					}
				: { type: "error", message },
		);
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
		session: Session,
		running: RunningTask,
		pending: QueuedTask | PendingSteer | undefined,
		startedAt: number,
		timing: AgentRunTiming,
	): Promise<void> {
		const durationMs = Date.now() - startedAt;
		const steer = session.pendingSteer;
		if (
			steer &&
			!session.scheduler.hasPendingSupersede() &&
			!running.task.result()
		) {
			delete session.pendingSteer;
			this.options.emit(id, { type: "aborted", durationMs, ...timing });
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
		log.info({ sessionId: id, durationMs, ...timing }, "run aborted");
		this.options.emit(id, { type: "aborted", durationMs, ...timing });
		this.completeTask(
			id,
			running.task,
			running.task.result()?.status ?? "cancelled",
		);
		this.options.sink?.({
			type: "task.completed",
			timestamp: new Date().toISOString(),
			sessionId: id,
			taskId: running.task.id,
			status: running.task.result()?.status ?? "cancelled",
			durationMs,
		});
		this.finishPending(id, pending);
		await this.advance(id, session, session.scheduler.settle(running.task));
	}

	private succeed(
		id: string,
		running: RunningTask,
		pending: QueuedTask | PendingSteer | undefined,
		startedAt: number,
		timing: AgentRunTiming,
	): void {
		running.task.finish({
			status: "completed",
			terminalMessageIds: this.terminalMessages(id, running),
		});
		const durationMs = Date.now() - startedAt;
		log.info({ sessionId: id, durationMs, ...timing }, "run finished");
		this.options.emit(id, { type: "completed", durationMs, ...timing });
		this.completeTask(id, running.task, "completed");
		this.finishPending(id, pending);
	}

	private terminalMessages(id: string, running: RunningTask): string[] {
		return this.options.context.terminalizeTask(id, running.contextWatermark);
	}

	private async createTask({
		id,
		text,
		images,
		controller,
		predecessor,
		submissionWatermark,
	}: {
		id: string;
		text: string;
		images: ImageAttachment[];
		controller: AbortController;
		predecessor?: TaskRuntime;
		submissionWatermark?: number;
	}): Promise<RunningTask> {
		if (images.length) {
			if (
				!this.options.runtime.supportsImages(id, this.options.modelConfig(id))
			)
				throw new Error("configured model does not support images");
		}
		const bindingGeneration = crypto.randomUUID();
		const contextWatermark = this.options.store.contextSequence(id);
		const workspace = this.options.workspace(id);
		const tools = new CoreTools(workspace);
		const registry = this.options.mcpFor(id);
		const [scanned, prompts, mcp] = await Promise.all([
			scanSkills(workspace, undefined, bindingGeneration),
			scanPrompts(workspace),
			registry.snapshot(),
		]);
		const skills = [...scanned.discoverable, ...scanned.operatorOnly];
		for (const diagnostic of scanned.diagnostics)
			log.warn(
				{ sessionId: id, path: diagnostic.path, error: diagnostic.error },
				"skill ignored",
			);
		for (const diagnostic of mcp.diagnostics)
			log.warn(
				{
					sessionId: id,
					path: diagnostic.path,
					server: diagnostic.server,
					error: diagnostic.error,
				},
				"mcp server ignored",
			);
		/** A template expands before skills are selected, so it can invoke them. */
		const { text: expanded, template } = expandPrompt(text, prompts.templates);
		if (template)
			log.info(
				{ sessionId: id, prompt: template.name, path: template.path },
				"prompt template expanded",
			);
		const catalog = new CapabilityCatalog(
			[
				...tools.capabilities(bindingGeneration),
				...contextCapabilities(bindingGeneration),
				...mcpCapabilities(mcp.tools, bindingGeneration),
				...skills.map(({ capability }) => capability),
			],
			bindingGeneration,
		);
		const snapshot = catalog.snapshot({
			tool: { maxLevel: "execute", confirmation: "none" },
			skill: { maxLevel: "activate" },
		});
		const { task, context, accountant } = this.createRuntime({
			id,
			snapshot,
			contextWatermark,
			...(predecessor ? { predecessor } : {}),
			...(submissionWatermark === undefined ? {} : { submissionWatermark }),
		});
		for (const skill of skills)
			this.options.sink?.({
				type: "skill.discovered",
				timestamp: new Date().toISOString(),
				sessionId: id,
				taskId: task.id,
				skill: skill.capability.name,
				skillHash: skill.ref.bodyHash,
			});
		this.options.sink?.({
			type: "capability.snapshot.created",
			timestamp: new Date().toISOString(),
			sessionId: id,
			taskId: task.id,
			capabilitySnapshotId: bindingGeneration,
		});
		this.loadTools(task, snapshot, context, accountant);
		const { prompt, selected } = selectedSkills(expanded, skills);
		const skipped = await this.activateSkills(
			id,
			task.id,
			selected,
			snapshot,
			context,
			accountant,
		);
		this.options.context.recover();
		this.options.store.startContextTask(id, task.id, task.startedAt);
		return {
			controller,
			task,
			tools,
			skills,
			mcpTools: mcp.tools,
			mcp: registry,
			prompt: withSkippedSkills(prompt, skipped),
			contextWatermark,
		};
	}

	private createRuntime({
		id,
		snapshot,
		contextWatermark,
		predecessor,
		submissionWatermark,
	}: {
		id: string;
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
			{ model: this.options.modelConfig(id) },
			(base, items) => ({
				base,
				capabilityContext: items.map(({ content }) => content),
			}),
			this.options.runtime.capabilityBudget(id, this.options.modelConfig(id)),
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
				sessionId: id,
				...(this.options.sink ? { sink: this.options.sink } : {}),
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

	/**
	 * Tools harnez ships are loaded up front because they are already in the
	 * model's tool list. Everything else — today, MCP — stays catalog-only until
	 * `tools_load` admits it, so a server advertising hundreds of tools costs one
	 * catalog entry each instead of a schema in every request.
	 */
	private loadTools(
		task: TaskRuntime,
		snapshot: CapabilitySnapshot,
		context: CapabilityContext,
		accountant: TokenAccountant,
	): void {
		/**
		 * Discovery is paginated and ordered by id, so a catalog large enough to
		 * span pages would otherwise strand core tools behind `tool:mcp__…`.
		 */
		let cursor: string | undefined;
		do {
			const page = snapshot.list({
				kind: "tool",
				limit: 100,
				...(cursor === undefined ? {} : { cursor }),
			});
			for (const item of page.items) {
				if (isMcpProvider(item.ref.providerBinding.providerId)) continue;
				const inspected = snapshot.inspect(item.ref);
				const admission = context.admit({
					capability: item.ref,
					scope: "task",
					contentHash: item.ref.contractHash,
					content: inspected.contract,
					accountant,
				});
				if (admission.status === "rejected") {
					log.error(
						{ tool: item.ref.id, admission },
						"core tool did not fit the capability budget",
					);
					throw new Error(
						describeRejection(admission, `The ${inspected.name} tool`),
					);
				}
				task.load(item.ref);
			}
			cursor = page.nextCursor;
		} while (cursor !== undefined);
	}

	/**
	 * A skill that will not fit is the user's own `/name` failing, not a broken
	 * session: losing the whole submission over it throws away the prompt too.
	 * The turn runs without the skill and says so, and the caller folds the
	 * reasons into the prompt so the model does not silently answer as though
	 * the skill had been applied.
	 */
	private async activateSkills(
		id: string,
		taskId: string,
		selected: readonly SkillSnapshotEntry[],
		snapshot: CapabilitySnapshot,
		context: CapabilityContext,
		accountant: TokenAccountant,
	): Promise<string[]> {
		const skipped: string[] = [];
		for (const entry of selected) {
			this.options.sink?.({
				type: "skill.inspected",
				timestamp: new Date().toISOString(),
				sessionId: id,
				taskId,
				skill: entry.capability.name,
				skillHash: entry.ref.bodyHash,
			});
			const ref = snapshot.reference(entry.capability.id, "operator");
			const admission = await activateSkill(entry, ref, context, accountant);
			if (admission.status !== "rejected")
				this.options.sink?.({
					type: "skill.activated",
					timestamp: new Date().toISOString(),
					sessionId: id,
					taskId,
					skill: entry.capability.name,
					skillHash: entry.ref.bodyHash,
				});
			if (admission.status !== "rejected") continue;
			const reason = describeRejection(
				admission,
				`The ${entry.capability.name} skill`,
			);
			log.warn(
				{ sessionId: id, skill: entry.capability.name, admission },
				"skill activation rejected",
			);
			this.options.emit(id, {
				type: "status",
				text: `skipped ${entry.capability.name}: over capability budget`,
			});
			skipped.push(reason);
		}
		return skipped;
	}

	private completeTask(
		id: string,
		task: TaskRuntime,
		status: TaskTerminalStatus,
	): void {
		this.options.context.clearPressure(task.id);
		this.options.runtime.forget(id);
		this.options.context.finishTask({
			sessionId: id,
			taskId: task.id,
			status: status === "superseded" ? "cancelled" : status,
			startedAt: task.startedAt,
			ledger: task.ledger(),
		});
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
			command: pendingCommandType(pending),
			state: "finished",
		});
	}
}

function commandText(
	command: string | InitialInput | QueuedTask | PendingSteer,
): string {
	if (typeof command === "string") return command;
	if (!("id" in command) && !("userInput" in command))
		return (command as InitialInput).text;
	return "userInput" in command
		? (command as QueuedTask).userInput.text
		: (command as PendingSteer).text;
}

function commandImages(
	command: string | InitialInput | QueuedTask | PendingSteer,
): ImageAttachment[] {
	if (typeof command === "string") return [];
	if (!("id" in command) && !("userInput" in command))
		return (command as InitialInput).images ?? [];
	return (
		("userInput" in command
			? (command as QueuedTask).userInput.images
			: (command as PendingSteer).images) ?? []
	);
}

function isInitialInput(command: object): command is InitialInput {
	return "text" in command && !("id" in command) && !("userInput" in command);
}

function displayText(text: string, images: readonly ImageAttachment[]): string {
	if (!images.length) return text;
	return displayUserInput(text, images);
}

export function pendingCommandType(
	pending: QueuedTask | PendingSteer,
): QueuedTask["kind"] | PendingSteer["type"];
export function pendingCommandType(
	pending: QueuedTask | PendingSteer | undefined,
): QueuedTask["kind"] | PendingSteer["type"] | undefined;
export function pendingCommandType(
	pending: QueuedTask | PendingSteer | undefined,
): QueuedTask["kind"] | PendingSteer["type"] | undefined {
	if (!pending) return undefined;
	return "kind" in pending ? pending.kind : pending.type;
}

/**
 * The model is told which skills it is missing rather than left to answer as if
 * it had them: a `/humanizer` that never activated otherwise reads to the user
 * as a skill that ran badly.
 */
function withSkippedSkills(prompt: string, skipped: readonly string[]): string {
	if (skipped.length === 0) return prompt;
	return `${prompt}\n\n<system-reminder>\n${skipped.join(
		"\n",
	)}\nAnswer without it and tell the user it was not applied.\n</system-reminder>`;
}

function selectedSkills(
	text: string,
	discoverable: readonly SkillSnapshotEntry[],
): { prompt: string; selected: SkillSnapshotEntry[] } {
	const names = new Set<string>();
	const prompt = text
		.replace(slashCommandPattern(), (match, prefix: string, name: string) => {
			if (discoverable.some((entry) => entry.capability.name === name)) {
				names.add(name);
				return prefix;
			}
			return match;
		})
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
