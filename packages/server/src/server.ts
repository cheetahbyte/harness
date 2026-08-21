import { statSync } from "node:fs";
import { resolve } from "node:path";

import {
	type CredentialStore,
	clampThinkingLevel,
	getSupportedThinkingLevels,
	type Models,
} from "@earendil-works/pi-ai";

import type {
	AuthType,
	ClientCommand,
	FastCycleEntry,
	ModelConfig,
	ModelOption,
	PromptOption,
	ProviderOption,
	ServerEvent,
	SkillOption,
	ImageAttachment,
} from "../../shared/src/protocol";
import { displayUserInput } from "../../shared/src/protocol";
import { HarnezAgentRuntime } from "./agent/runtime";
import { ContextManager } from "./context/manager";
import type { SubagentResult } from "./context/types";
import { validateImages } from "./images";
import { log } from "./logger";
import { McpConnectionPool } from "./mcp/pool";
import { McpRegistry } from "./mcp/registry";
import { scanPrompts } from "./prompts";
import {
	createHarnezModels,
	JsonCredentialStore,
	providerModels,
} from "./provider";
import {
	interactiveAuthTypes,
	type ModelRegistry,
	SessionAuthentication,
} from "./sessions/authentication";
import { promptTitle, SessionNamer } from "./sessions/naming";
import type { QueuedTask, SchedulerDecision } from "./sessions/scheduler";
import { Session } from "./sessions/session";
import { SessionStore } from "./sessions/store";
import {
	type PendingSteer,
	type InitialInput,
	pendingCommandType,
	type RunningTask,
	SessionTaskRunner,
} from "./sessions/task-runner";
import {
	globalHarnezPath,
	projectHarnezPath,
	SettingsStore,
} from "./settings-store";
import { availableSkills } from "./skills";
import { SubagentManager } from "./subagents/manager";
import { resolveAgentProfile, scanAgentProfiles } from "./subagents/profiles";
import { parentSubagentTools } from "./subagents/tools";
import type { TaskRuntime } from "./task-runtime";
import type { RuntimeEventSink } from "./telemetry/events";
import { CoreTools } from "./tools";

export class HarnezServer {
	private readonly telemetrySink: RuntimeEventSink | undefined;
	private readonly sessions = new Map<string, Session>();
	private readonly runtime: HarnezAgentRuntime;
	private readonly credentials: CredentialStore;
	private readonly models: ModelRegistry;
	private readonly injectedModels: boolean;
	private readonly workspaceModels = new Map<string, ModelRegistry>();
	private readonly workspaceSettings = new Map<string, SettingsStore>();
	private readonly workspaceMcp = new Map<string, McpRegistry>();
	private readonly defaultWorkspace: string;
	private readonly context: ContextManager;
	/** Shared by every workspace, so one server is one child process. */
	private readonly mcpPool = new McpConnectionPool();
	private readonly taskRunner: SessionTaskRunner;
	private readonly subagents: SubagentManager;
	private readonly authentication: SessionAuthentication;
	private readonly namer: SessionNamer;
	private readonly manuallyNamedSessions = new Set<string>();

	constructor(
		readonly store = new SessionStore(),
		workspace = process.cwd(),
		models?: ModelRegistry,
		private readonly defaultSettings = new SettingsStore(
			globalHarnezPath("settings.json"),
			projectHarnezPath("settings.json", resolve(workspace)),
		),
		options: {
			contextBudget?: number;
			telemetry?: RuntimeEventSink;
		} = {},
	) {
		this.store.recoverLanes();
		this.telemetrySink = options.telemetry;
		if (
			options.contextBudget !== undefined &&
			(!Number.isSafeInteger(options.contextBudget) ||
				options.contextBudget <= 0)
		)
			throw new Error("context budget must be a positive number");
		this.defaultWorkspace = workspacePath(workspace);
		this.credentials = new JsonCredentialStore(globalHarnezPath("auth.json"));
		this.injectedModels = !!models;
		this.models =
			models ??
			createHarnezModels(this.credentials, this.defaultSettings.providers());
		this.workspaceModels.set(this.defaultWorkspace, this.models);
		this.namer = new SessionNamer(this.models as Models, this.credentials);
		this.authentication = new SessionAuthentication(
			(id) => this.modelsFor(id),
			(id, event) => this.publish(id, event, false),
		);
		this.context = new ContextManager(this.store, options.telemetry);
		this.workspaceSettings.set(this.defaultWorkspace, this.defaultSettings);
		this.runtime = new HarnezAgentRuntime({
			credentials: this.credentials,
			modelsFor: (id) => this.modelsFor(id) as Models,
			store: this.store,
			context: this.context,
			...(options.contextBudget === undefined
				? {}
				: { contextBudget: options.contextBudget }),
			llmCompactionFor: (id) => this.settingsFor(id).compactionEnabled(),
			compactionModelConfigFor: (id) => this.settingsFor(id).compactionModel(),
			...(options.telemetry ? { sink: options.telemetry } : {}),
		});
		this.taskRunner = new SessionTaskRunner({
			runtime: this.runtime,
			store: this.store,
			context: this.context,
			mcpFor: (sessionId) => this.mcpFor(sessionId),
			workspace: (sessionId) => this.workspace(sessionId),
			modelConfig: (sessionId) => this.modelConfig(sessionId),
			emit: (sessionId, event) => this.publish(sessionId, event),
			...(options.telemetry ? { sink: options.telemetry } : {}),
		});
		this.subagents = new SubagentManager({
			store: this.store,
			context: this.context,
			resolveProfile: async (sessionId, name) => {
				const availableModels = await this.modelsFor(sessionId).getAvailable();
				return resolveAgentProfile(
					await scanAgentProfiles(this.workspace(sessionId)),
					name,
					{
						parentModel: this.modelConfig(sessionId),
						resolveModel: (config) => {
							providerModels(
								config,
								this.credentials,
								this.modelsFor(sessionId) as Models,
							);
						},
						capabilities: new CoreTools(this.workspace(sessionId)).capabilities(
							"subagent-profile",
						),
						models: availableModels.map((model) => ({
							provider: model.provider,
							model: model.id,
						})),
					},
				);
			},
			execute: async (request) => this.taskRunner.runSubagent(request),
			steer: (agentId, message) =>
				this.runtime.steer(agentId, message, {
					onStarted() {},
					onFinished() {},
				}),
			forget: (agentId) => this.runtime.forget(agentId),
			emit: (sessionId, record) =>
				this.publish(
					sessionId,
					{
						type: "subagent-state",
						agent: {
							id: record.id,
							profile: record.profile,
							description: record.description,
							state: record.state,
							...(record.startedAt ? { startedAt: record.startedAt } : {}),
							...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
							...(record.result?.summary
								? { summary: record.result.summary }
								: {}),
						},
					},
					false,
				),
			limits: (sessionId) => this.settingsFor(sessionId).subagents(),
		});
		this.taskRunner.setSubagentTools(async (sessionId) =>
			parentSubagentTools(
				this.subagents,
				sessionId,
				(await scanAgentProfiles(this.workspace(sessionId))).profiles,
			),
		);
		this.subagents.recover();
	}

	/** Releases process-level resources; stdio MCP servers are child processes. */
	async close(): Promise<void> {
		for (const id of this.sessions.keys())
			this.telemetrySink?.({
				type: "session.completed",
				timestamp: new Date().toISOString(),
				sessionId: id,
			});
		const registries = [...this.workspaceMcp.values()];
		this.workspaceMcp.clear();
		await Promise.allSettled(registries.map((registry) => registry.close()));
		await this.mcpPool.close();
	}

	createSession(workspace = this.defaultWorkspace): string {
		const id = this.store.create(workspacePath(workspace));
		this.sessions.set(id, new Session());
		// Connecting starts now so the first prompt does not pay for the handshake.
		this.mcpFor(id);
		this.telemetrySink?.({
			type: "session.started",
			timestamp: new Date().toISOString(),
			sessionId: id,
		});
		log.info({ sessionId: id }, "session created");
		return id;
	}

	workspace(id: string): string {
		if (!this.store.exists(id)) throw new Error("session not found");
		return this.store.workspace(id) ?? this.defaultWorkspace;
	}

	contextStatus(id: string) {
		this.session(id);
		return this.runtime.inspect(id, id, "main");
	}

	async subagentTranscript(
		id: string,
		agentId: string,
		after = 0,
		limit = 100,
	) {
		await this.subagents.get(id, agentId);
		return this.store
			.contextPath(id, agentId)
			.filter(
				(item) =>
					item.sequence > after &&
					["user", "assistant", "tool-result"].includes(item.kind),
			)
			.slice(0, limit);
	}

	subagentStatus(id: string, agentId: string) {
		return this.subagents.get(id, agentId);
	}

	acceptSubagentResult(id: string, result: SubagentResult, subagentId: string) {
		this.session(id);
		const existing = this.store
			.contextItems(id)
			.find(
				(item) =>
					item.kind === "subagent-handoff" &&
					item.source?.subagentId === subagentId,
			);
		if (existing) return existing;
		let lane = this.store.lane(id, subagentId);
		if (!lane) {
			const main = this.store.lane(id, "main");
			if (!main?.headItemId)
				return this.context.recordSubagentResult(id, result, { subagentId });
			lane = this.context.forkLane({
				sessionId: id,
				name: subagentId,
				ownerTaskId: subagentId,
				fromItemId: main.headItemId,
			});
		}
		const taskId = lane.ownerTaskId ?? subagentId;
		this.context.finishTask({
			sessionId: id,
			taskId,
			laneId: lane.name,
			status: result.status === "completed" ? "completed" : "failed",
			handoff: result,
		});
		const handoff = this.store.contextItem(`handoff-${taskId}`);
		if (!handoff) throw new Error("subagent handoff was not persisted");
		return handoff;
	}

	/** Replays persisted events after `from`, then streams live ones. */
	subscribe(
		id: string,
		listener: (event: ServerEvent, seq?: number) => void,
		from = 0,
	): () => void {
		const session = this.session(id);
		session.events.on("event", listener);
		for (const { seq, event } of this.store.eventsFrom(id, from))
			listener(event, seq);
		for (const agent of this.subagents.snapshot(id))
			listener({ type: "subagent-state", agent: agent });
		const model = this.modelConfig(id);
		if (model) listener({ type: "model-config", config: model });
		listener({ type: "fast-cycle", entries: this.settingsFor(id).fastCycle() });
		listener({
			type: "ui-settings",
			disableThinkingBlocks: this.settingsFor(id).disableThinkingBlocks(),
		});
		return () => session.events.off("event", listener);
	}

	reportError(id: string, error: unknown): void {
		this.publish(id, {
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	async command(id: string, command: ClientCommand): Promise<void> {
		const session = this.session(id);
		const validatedImages = validateImages(
			isUserSubmission(command) && "images" in command
				? command.images
				: undefined,
		);
		log.debug({ sessionId: id, command: command.type }, "command received");
		if (isUserSubmission(command)) this.store.markUserMessage(id);
		if (isImmediateCommand(command.type)) {
			await this.handleImmediateCommand(id, command);
			return;
		}
		if (session.starting) await session.starting;
		if (isActiveControl(command.type)) {
			await this.handleActiveControl(id, session, command);
			return;
		}
		if (isQueueControl(command.type)) {
			await this.handleQueueControl(id, session, command);
			return;
		}
		if (command.type === "cycle-thinking-level") {
			this.cycleThinkingLevel(id, session);
			return;
		}
		if (command.type === "cycle-model") {
			this.cycleModel(id, session);
			return;
		}
		if (this.handleConfigure(id, session, command)) return;
		if (this.handleQueuedSubmission(id, session, command)) return;
		if (command.type === "supersede") {
			await this.handleSupersede(id, session, command);
			return;
		}
		if (command.type === "steer") {
			await this.handleSteer(id, session, command);
			return;
		}
		if (command.type !== "prompt") throw new Error("unsupported command");
		await this.submitPrompt(id, session, command.text, validatedImages);
	}

	private async handleImmediateCommand(
		id: string,
		command: ClientCommand,
	): Promise<void> {
		switch (command.type) {
			case "list-providers":
				await this.listProviders(id, command.authType);
				return;
			case "list-models":
				await this.listModels(id, command.provider);
				return;
			case "list-skills":
				await this.listSkills(id);
				return;
			case "list-prompts":
				await this.listPrompts(id);
				return;
			case "list-mcp-servers":
				await this.listMcpServers(id);
				return;
			case "set-mcp-enabled":
				await this.setMcpEnabled(id, command.servers);
				return;
			case "set-session-title": {
				const title =
					typeof command.title === "string"
						? command.title.replace(/\s+/g, " ").trim()
						: "";
				if (!title) throw new Error("session name is required");
				this.manuallyNamedSessions.add(id);
				this.store.claimNamingPrompt(id);
				this.store.setTitle(id, title);
				return;
			}
			case "set-fast-cycle":
				this.setFastCycle(id, command.entries);
				return;
			case "set-disable-thinking-blocks":
				this.settingsFor(id).setDisableThinkingBlocks(command.disabled);
				this.publish(
					id,
					{ type: "ui-settings", disableThinkingBlocks: command.disabled },
					false,
				);
				return;
			case "login":
				this.authentication.start(id, command.provider, command.authType);
				return;
			case "auth-answer":
				this.authentication.answer(id, command.promptId, command.value);
				return;
			case "auth-cancel":
				this.authentication.cancel(id);
				return;
			default:
				throw new Error("command is not immediate");
		}
	}

	private async handleActiveControl(
		id: string,
		session: Session,
		command: ClientCommand,
	): Promise<void> {
		if (command.type === "abort") {
			log.info({ sessionId: id, running: !!session.running }, "run aborted");
			if (
				command.taskId &&
				session.running &&
				session.running.task.id !== command.taskId
			)
				throw new Error("task is not active");
			if (!session.running) return;
			if (session.pendingSteer) {
				this.publish(id, {
					type: "command",
					id: session.pendingSteer.id,
					command: "steer",
					state: "cancelled",
				});
				delete session.pendingSteer;
			}
			this.publish(id, {
				type: "task-state",
				taskId: session.running.task.id,
				state: "cancelling",
			});
			session.running.controller.abort();
			await session.running.task.cancel("cancelled");
			return;
		}
		if (command.type === "confirm") {
			this.activeTask(session, command.taskId).confirm(command.callId);
			return;
		}
		if (command.type === "acknowledge-unknown-effects") {
			this.activeTask(session, command.taskId).acknowledgeUnknownPriorEffects();
			return;
		}
	}

	private async handleQueueControl(
		id: string,
		session: Session,
		command: ClientCommand,
	): Promise<void> {
		if (command.type === "resume-queued") {
			const queued = session.scheduler.resume(command.taskId);
			this.emitCommand(id, queued, "queued");
			await this.advance(id, session.scheduler.next());
			return;
		}
		if (command.type === "cancel-queued") {
			const queued = session.scheduler.cancelQueued(command.taskId);
			this.emitCommand(id, queued, "cancelled");
			await this.advance(id, session.scheduler.next());
			return;
		}
		if (command.type !== "replace-queued") return;
		const { cancelled, queued } = session.scheduler.replaceQueued(
			command.taskId,
			{
				id: command.id ?? crypto.randomUUID(),
				text: command.text,
				...(inputImages(command).length
					? { images: inputImages(command) }
					: {}),
			},
			this.store.contextSequence(id),
		);
		this.emitCommand(id, cancelled, "cancelled");
		this.emitCommand(id, queued, "queued");
		await this.advance(id, session.scheduler.next());
	}

	private handleConfigure(
		id: string,
		session: Session,
		command: ClientCommand,
		allowRunning = false,
	): boolean {
		if (command.type !== "configure") return false;
		if (session.running && !allowRunning)
			throw new Error("cannot change model while running");
		const selected = {
			provider: command.provider,
			model: command.model,
			...(command.baseUrl ? { baseUrl: command.baseUrl } : {}),
		};
		const { model } = providerModels(
			selected,
			this.credentials,
			this.modelsFor(id) as Models,
		);
		/** An unset level falls back to the one this model last cycled to. */
		const thinkingLevel =
			command.thinkingLevel ??
			this.fastCycleEntry(id, selected)?.thinkingLevel ??
			undefined;
		const config = {
			...selected,
			...(thinkingLevel
				? { thinkingLevel: clampThinkingLevel(model, thinkingLevel) }
				: {}),
		};
		this.store.setModelConfig(id, config);
		this.settingsFor(id).setModelConfig(config);
		if (!session.running) this.runtime.forget(id);
		this.publish(id, { type: "model-config", config });
		return true;
	}

	private cycleThinkingLevel(id: string, session: Session): void {
		const config = this.modelConfig(id);
		if (!config) throw new Error("select a model with /model");
		const { model } = providerModels(
			config,
			this.credentials,
			this.modelsFor(id) as Models,
		);
		const levels = getSupportedThinkingLevels(model);
		const current = clampThinkingLevel(model, config.thinkingLevel ?? "medium");
		const next = levels[(levels.indexOf(current) + 1) % levels.length];
		if (!next) throw new Error("model has no supported thinking levels");
		this.handleConfigure(
			id,
			session,
			{
				type: "configure",
				...config,
				thinkingLevel: next,
			},
			true,
		);
		this.rememberThinkingLevel(id, config, next);
	}

	/** Cycles to the next available `/fast-cycle` entry, each with its own level. */
	private cycleModel(id: string, session: Session): void {
		const entries = this.settingsFor(id).fastCycle();
		if (!entries.length)
			throw new Error("no fast-cycle models; pick some with /fast-cycle");
		const current = this.modelConfig(id);
		const from = current
			? entries.findIndex((entry) => sameModel(entry, current))
			: -1;
		for (let offset = 1; offset <= entries.length; offset++) {
			const entry = entries[(from + offset + entries.length) % entries.length];
			if (!entry || !this.available(id, entry)) continue;
			this.handleConfigure(id, session, { type: "configure", ...entry }, true);
			return;
		}
		throw new Error("no fast-cycle model is available");
	}

	private setFastCycle(id: string, entries: FastCycleEntry[]): void {
		if (!Array.isArray(entries)) throw new Error("fast-cycle entries required");
		const settings = this.settingsFor(id);
		const normalized: FastCycleEntry[] = [];
		for (const entry of entries) {
			if (!entry?.provider || !entry.model)
				throw new Error("fast-cycle entries need a provider and a model");
			if (normalized.some((existing) => sameModel(existing, entry))) continue;
			/** Keep the level the entry already had unless the picker sent one. */
			const thinkingLevel =
				entry.thinkingLevel ?? this.fastCycleEntry(id, entry)?.thinkingLevel;
			normalized.push({
				provider: entry.provider,
				model: entry.model,
				...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
				...(thinkingLevel ? { thinkingLevel } : {}),
			});
		}
		settings.setFastCycle(normalized);
		this.publish(id, { type: "fast-cycle", entries: normalized }, false);
	}

	private rememberThinkingLevel(
		id: string,
		config: ModelConfig,
		thinkingLevel: NonNullable<ModelConfig["thinkingLevel"]>,
	): void {
		const settings = this.settingsFor(id);
		const entries = settings.fastCycle();
		if (!entries.some((entry) => sameModel(entry, config))) return;
		const updated = entries.map((entry) =>
			sameModel(entry, config) ? { ...entry, thinkingLevel } : entry,
		);
		settings.setFastCycle(updated);
		this.publish(id, { type: "fast-cycle", entries: updated }, false);
	}

	private fastCycleEntry(
		id: string,
		config: ModelConfig,
	): FastCycleEntry | undefined {
		return this.settingsFor(id)
			.fastCycle()
			.find((entry) => sameModel(entry, config));
	}

	private available(id: string, config: ModelConfig): boolean {
		try {
			providerModels(config, this.credentials, this.modelsFor(id) as Models);
			return true;
		} catch (error) {
			log.debug({ error, config }, "fast-cycle model unavailable");
			return false;
		}
	}

	private handleQueuedSubmission(
		id: string,
		session: Session,
		command: ClientCommand,
	): boolean {
		if (command.type !== "follow-up" && command.type !== "enqueue")
			return false;
		const pending = session.scheduler.enqueue(
			{
				id: command.id ?? crypto.randomUUID(),
				text: command.text,
				...(inputImages(command).length
					? { images: inputImages(command) }
					: {}),
			},
			this.store.contextSequence(id),
			{
				requirePredecessorSuccess:
					command.type === "enqueue" &&
					command.requirePredecessorSuccess === true,
			},
		);
		this.emitCommand(id, pending, "queued");
		this.publish(id, { type: "status", text: "follow-up queued" });
		return true;
	}

	private async handleSupersede(
		id: string,
		session: Session,
		command: Extract<ClientCommand, { type: "supersede" }>,
	): Promise<void> {
		if (!session.running) {
			const commandId = command.id ?? crypto.randomUUID();
			await this.run(id, {
				id: commandId,
				kind: "supersede",
				state: "ready",
				userInput: {
					id: commandId,
					text: command.text,
					...(inputImages(command).length
						? { images: inputImages(command) }
						: {}),
				},
				submissionWatermark: this.store.contextSequence(id),
				requirePredecessorSuccess: false,
			});
			return;
		}
		if (command.taskId && command.taskId !== session.running.task.id)
			throw new Error("task is not active");
		if (session.pendingSteer) {
			this.publish(id, {
				type: "command",
				id: session.pendingSteer.id,
				command: "steer",
				state: "replaced",
			});
			delete session.pendingSteer;
		}
		const { queued, replaced } = session.scheduler.requestSupersede(
			session.running.task.id,
			{
				id: command.id ?? crypto.randomUUID(),
				text: command.text,
				...(inputImages(command).length
					? { images: inputImages(command) }
					: {}),
			},
			this.store.contextSequence(id),
		);
		if (replaced) this.emitCommand(id, replaced, "replaced");
		this.emitCommand(id, queued, "queued");
		this.publish(id, {
			type: "task-state",
			taskId: session.running.task.id,
			state: "cancelling",
		});
		session.running.controller.abort();
		await session.running.task.cancel("superseded");
	}

	private async handleSteer(
		id: string,
		session: Session,
		command: Extract<ClientCommand, { type: "steer" }>,
	): Promise<void> {
		const pending: PendingSteer = {
			id: command.id ?? crypto.randomUUID(),
			type: "steer",
			text: command.text,
			...(inputImages(command).length ? { images: inputImages(command) } : {}),
		};
		if (!session.running) {
			this.maybeTitleSession(
				id,
				displayUserInput(command.text, inputImages(command)),
			);
			await this.run(id, pending);
			return;
		}
		if (
			this.runtime.steer(
				id,
				pending.text,
				{
					onStarted: () => {
						this.publish(id, {
							type: "user",
							id: pending.id,
							text: pending.text,
						});
						this.emitCommand(id, pending, "started");
					},
					onFinished: () => {},
					onReplaced: () => this.emitCommand(id, pending, "replaced"),
				},
				pending.images,
			)
		)
			return;
		if (session.pendingSteer)
			this.emitCommand(id, session.pendingSteer, "replaced");
		session.pendingSteer = pending;
		this.publish(id, { type: "status", text: "steering after current turn" });
		session.running.controller.abort();
	}

	private async submitPrompt(
		id: string,
		session: Session,
		text: string,
		attachments: ImageAttachment[] = [],
	): Promise<void> {
		this.maybeTitleSession(id, displayUserInput(text, attachments));
		if (!session.running) {
			await this.run(id, {
				text,
				...(attachments.length ? { images: attachments } : {}),
			} as InitialInput);
			return;
		}
		const pending = session.scheduler.enqueue(
			{
				id: crypto.randomUUID(),
				text,
				...(attachments.length ? { images: attachments } : {}),
			},
			this.store.contextSequence(id),
		);
		this.emitCommand(id, pending, "queued");
	}

	private maybeTitleSession(id: string, prompt: string): void {
		if (!this.store.claimNamingPrompt(id)) return;
		const config = this.settingsFor(id).sessionTitle();
		if (!config.generated) return;
		const fallback = promptTitle(prompt);
		if (fallback) this.store.setTitle(id, fallback);
		void this.namer
			.generate(
				prompt,
				config.source,
				this.modelConfig(id),
				this.modelsFor(id) as Models,
			)
			.then((title) => {
				if (title && !this.manuallyNamedSessions.has(id))
					this.store.setTitle(id, title);
			})
			.catch((error) =>
				log.debug({ error, sessionId: id }, "session title generation failed"),
			);
	}

	private activeTask(session: Session, taskId: string): TaskRuntime {
		if (session.running?.task.id !== taskId)
			throw new Error("task is not active");
		return session.running.task;
	}

	private emitCommand(
		id: string,
		command: QueuedTask | PendingSteer,
		state: "queued" | "started" | "cancelled" | "replaced",
	): void {
		this.publish(id, {
			type: "command",
			id: command.id,
			command: pendingCommandType(command),
			state,
		});
	}

	private async listProviders(id: string, authType?: AuthType): Promise<void> {
		const models = this.modelsFor(id);
		const providers = await Promise.all(
			models
				.getProviders()
				.map(async (provider): Promise<ProviderOption | undefined> => {
					const authTypes = interactiveAuthTypes(provider.auth);
					if (!authTypes.length || (authType && !authTypes.includes(authType)))
						return undefined;
					const configured = await models
						.checkAuth(provider.id)
						.then(Boolean)
						.catch(() => false);
					return {
						id: provider.id,
						name: provider.name,
						authTypes,
						configured,
					};
				}),
		);
		this.publish(
			id,
			{
				type: "providers",
				providers: providers
					.filter((provider): provider is ProviderOption => !!provider)
					.toSorted((a, b) => a.name.localeCompare(b.name)),
			},
			false,
		);
	}

	private async listModels(id: string, provider?: string): Promise<void> {
		const registry = this.modelsFor(id);
		const models = await registry.getAvailable(provider);
		const options: ModelOption[] = models.map((model) => ({
			provider: model.provider,
			providerName:
				registry.getProvider(model.provider)?.name ?? model.provider,
			id: model.id,
			name: model.name,
		}));
		options.sort(
			(a, b) =>
				a.providerName.localeCompare(b.providerName) ||
				a.name.localeCompare(b.name),
		);
		this.publish(id, { type: "models", models: options }, false);
	}

	private async listSkills(id: string): Promise<void> {
		const skills: SkillOption[] = (
			await availableSkills(this.workspace(id))
		).map(({ name, description }) => ({ name, description }));
		this.publish(id, { type: "skills", skills }, false);
	}

	private async listPrompts(id: string): Promise<void> {
		const { templates, diagnostics } = await scanPrompts(this.workspace(id));
		for (const diagnostic of diagnostics)
			log.warn(
				{ sessionId: id, path: diagnostic.path, error: diagnostic.error },
				"prompt template ignored",
			);
		const prompts: PromptOption[] = templates.map(({ name, description }) => ({
			name,
			description,
		}));
		this.publish(id, { type: "prompts", prompts }, false);
	}

	private async listMcpServers(id: string): Promise<void> {
		this.publish(
			id,
			{ type: "mcp-servers", servers: await this.mcpFor(id).list() },
			false,
		);
	}

	/**
	 * The menu sends back the servers that stay on, so a server added to
	 * `mcp.json` while the menu was open is never switched off by an answer that
	 * predates it: only servers the operator actually saw can be excluded.
	 */
	private async setMcpEnabled(id: string, servers: string[]): Promise<void> {
		const enabled = new Set(servers);
		const registry = this.mcpFor(id);
		const disabled = (await registry.list())
			.map((server) => server.name)
			.filter((name) => !enabled.has(name));
		this.settingsFor(id).setDisabledMcpServers(disabled);
		const off = new Set(disabled);
		await registry.setEnabled((server) => !off.has(server));
		await this.listMcpServers(id);
	}

	private run(
		id: string,
		command: string | InitialInput | QueuedTask | PendingSteer,
		predecessor?: TaskRuntime,
		resume?: RunningTask,
	): Promise<void> {
		return this.taskRunner.run({
			id,
			session: this.session(id),
			command,
			...(predecessor ? { predecessor } : {}),
			...(resume ? { resume } : {}),
		});
	}

	private advance(
		id: string,
		decision: SchedulerDecision | undefined,
	): Promise<void> {
		return this.taskRunner.advance(id, this.session(id), decision);
	}

	private modelConfig(id: string) {
		return this.store.modelConfig(id) ?? this.settingsFor(id).modelConfig();
	}

	/**
	 * Memoized per workspace: a store caches what it read, so handing out a fresh
	 * one per call would lose writes made through an earlier instance — which is
	 * exactly what the MCP toggle does when it saves and then re-reads.
	 */
	private settingsFor(id: string): SettingsStore {
		const workspace = this.workspace(id);
		let settings = this.workspaceSettings.get(workspace);
		if (!settings) {
			settings = new SettingsStore(
				globalHarnezPath("settings.json"),
				projectHarnezPath("settings.json", resolve(workspace)),
			);
			this.workspaceSettings.set(workspace, settings);
		}
		return settings;
	}

	/**
	 * The session's own MCP registry. Servers are declared per workspace, so a
	 * session in one project must never inherit another project's `mcp.json` —
	 * nor the binaries a relative `command` in it resolves to.
	 */
	private mcpFor(id: string): McpRegistry {
		const workspace = this.workspace(id);
		let registry = this.workspaceMcp.get(workspace);
		if (!registry) {
			const settings = this.settingsFor(id);
			registry = new McpRegistry(workspace, {
				enabled: (server) => !settings.disabledMcpServers().includes(server),
				pool: this.mcpPool,
			});
			this.workspaceMcp.set(workspace, registry);
			registry.start();
		}
		return registry;
	}

	private modelsFor(id: string): ModelRegistry {
		if (this.injectedModels) return this.models;
		const workspace = this.workspace(id);
		let models = this.workspaceModels.get(workspace);
		if (!models) {
			models = createHarnezModels(
				this.credentials,
				this.settingsFor(id).providers(),
			);
			this.workspaceModels.set(workspace, models);
		}
		return models;
	}

	private session(id: string): Session {
		if (!this.store.exists(id)) throw new Error("session not found");
		let session = this.sessions.get(id);
		if (!session) {
			session = new Session();
			this.sessions.set(id, session);
		}
		return session;
	}

	private publish(id: string, event: ServerEvent, persist = true): void {
		const seq = persist ? this.store.append(id, event) : undefined;
		this.session(id).events.emit("event", event, seq);
	}
}

function sameModel(a: ModelConfig, b: ModelConfig): boolean {
	return (
		a.provider === b.provider &&
		a.model === b.model &&
		(a.baseUrl ?? "") === (b.baseUrl ?? "")
	);
}

function workspacePath(path: string): string {
	const workspace = resolve(path);
	try {
		if (statSync(workspace).isDirectory()) return workspace;
	} catch {}
	throw new Error("workspace must be an existing directory");
}

function isImmediateCommand(type: ClientCommand["type"]): boolean {
	return (
		type === "list-providers" ||
		type === "list-models" ||
		type === "list-skills" ||
		type === "list-prompts" ||
		type === "list-mcp-servers" ||
		type === "set-mcp-enabled" ||
		type === "set-session-title" ||
		type === "set-fast-cycle" ||
		type === "set-disable-thinking-blocks" ||
		type === "login" ||
		type === "auth-answer" ||
		type === "auth-cancel"
	);
}

function isUserSubmission(command: ClientCommand): boolean {
	return (
		(command.type === "prompt" ||
			command.type === "steer" ||
			command.type === "follow-up" ||
			command.type === "enqueue" ||
			command.type === "supersede" ||
			command.type === "replace-queued") &&
		typeof command.text === "string" &&
		(command.text.trim().length > 0 ||
			(Array.isArray(command.images) && command.images.length > 0))
	);
}

function inputImages(command: { images?: unknown }): ImageAttachment[] {
	return validateImages(command.images);
}

function isActiveControl(type: ClientCommand["type"]): boolean {
	return (
		type === "abort" ||
		type === "confirm" ||
		type === "acknowledge-unknown-effects"
	);
}

function isQueueControl(type: ClientCommand["type"]): boolean {
	return (
		type === "resume-queued" ||
		type === "cancel-queued" ||
		type === "replace-queued"
	);
}
