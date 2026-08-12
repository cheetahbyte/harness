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
	ModelOption,
	ProviderOption,
	ServerEvent,
	SkillOption,
} from "../../shared/src/protocol";
import { HarnessAgentRuntime } from "./agent/runtime";
import { ContextManager } from "./context/manager";
import type { SubagentResult } from "./context/types";
import { log } from "./logger";
import {
	createHarnessModels,
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
	pendingCommandType,
	type RunningTask,
	SessionTaskRunner,
} from "./sessions/task-runner";
import { globalHarnessPath, SettingsStore } from "./settings-store";
import { availableSkills } from "./skills";
import type { TaskRuntime } from "./task-runtime";

export class HarnessServer {
	private readonly sessions = new Map<string, Session>();
	private readonly runtime: HarnessAgentRuntime;
	private readonly credentials: CredentialStore;
	private readonly models: ModelRegistry;
	private readonly defaultWorkspace: string;
	private readonly context: ContextManager;
	private readonly taskRunner: SessionTaskRunner;
	private readonly authentication: SessionAuthentication;
	private readonly namer: SessionNamer;
	private readonly manuallyNamedSessions = new Set<string>();

	constructor(
		readonly store = new SessionStore(),
		workspace = process.cwd(),
		models?: ModelRegistry,
		private readonly defaultSettings = new SettingsStore(
			globalHarnessPath("settings.json"),
			resolve(workspace, ".harness/settings.json"),
		),
		options: { contextBudget?: number } = {},
	) {
		if (
			options.contextBudget !== undefined &&
			(!Number.isSafeInteger(options.contextBudget) ||
				options.contextBudget <= 0)
		)
			throw new Error("context budget must be a positive number");
		this.defaultWorkspace = workspacePath(workspace);
		this.credentials = new JsonCredentialStore(globalHarnessPath("auth.json"));
		this.models = models ?? createHarnessModels(this.credentials);
		this.namer = new SessionNamer(this.models as Models, this.credentials);
		this.authentication = new SessionAuthentication(this.models, (id, event) =>
			this.publish(id, event, false),
		);
		this.context = new ContextManager(this.store);
		this.runtime = new HarnessAgentRuntime({
			credentials: this.credentials,
			models: this.models as Models,
			store: this.store,
			context: this.context,
			...(options.contextBudget === undefined
				? {}
				: { contextBudget: options.contextBudget }),
		});
		this.taskRunner = new SessionTaskRunner({
			runtime: this.runtime,
			store: this.store,
			context: this.context,
			capabilityBudget: 8_000,
			workspace: (sessionId) => this.workspace(sessionId),
			modelConfig: (sessionId) => this.modelConfig(sessionId),
			emit: (sessionId, event) => this.publish(sessionId, event),
		});
	}

	createSession(workspace = this.defaultWorkspace): string {
		const id = this.store.create(workspacePath(workspace));
		this.sessions.set(id, new Session());
		log.info({ sessionId: id }, "session created");
		return id;
	}

	workspace(id: string): string {
		if (!this.store.exists(id)) throw new Error("session not found");
		return this.store.workspace(id) ?? this.defaultWorkspace;
	}

	contextStatus(id: string) {
		this.session(id);
		return this.runtime.inspect(id);
	}

	acceptSubagentResult(id: string, result: SubagentResult, subagentId: string) {
		this.session(id);
		return this.context.recordSubagentResult(id, result, { subagentId });
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
		const model = this.modelConfig(id);
		if (model) listener({ type: "model-config", config: model });
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
		await this.submitPrompt(id, session, command.text);
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
			{ id: command.id ?? crypto.randomUUID(), text: command.text },
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
			this.models as Models,
		);
		const config = {
			...selected,
			...(command.thinkingLevel
				? { thinkingLevel: clampThinkingLevel(model, command.thinkingLevel) }
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
			this.models as Models,
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
	}

	private handleQueuedSubmission(
		id: string,
		session: Session,
		command: ClientCommand,
	): boolean {
		if (command.type !== "follow-up" && command.type !== "enqueue")
			return false;
		const pending = session.scheduler.enqueue(
			{ id: command.id ?? crypto.randomUUID(), text: command.text },
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
				userInput: { id: commandId, text: command.text },
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
			{ id: command.id ?? crypto.randomUUID(), text: command.text },
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
		};
		if (!session.running) {
			this.maybeTitleSession(id, command.text);
			await this.run(id, pending);
			return;
		}
		if (
			this.runtime.steer(id, pending.text, {
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
			})
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
	): Promise<void> {
		this.maybeTitleSession(id, text);
		if (!session.running) {
			await this.run(id, text);
			return;
		}
		const pending = session.scheduler.enqueue(
			{ id: crypto.randomUUID(), text },
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
			.generate(prompt, config.source, this.modelConfig(id))
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
		const providers = await Promise.all(
			this.models
				.getProviders()
				.map(async (provider): Promise<ProviderOption | undefined> => {
					const authTypes = interactiveAuthTypes(provider.auth);
					if (!authTypes.length || (authType && !authTypes.includes(authType)))
						return undefined;
					const configured = await this.models
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
					.sort((a, b) => a.name.localeCompare(b.name)),
			},
			false,
		);
	}

	private async listModels(id: string, provider?: string): Promise<void> {
		const models = await this.models.getAvailable(provider);
		const options: ModelOption[] = models.map((model) => ({
			provider: model.provider,
			providerName:
				this.models.getProvider(model.provider)?.name ?? model.provider,
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

	private run(
		id: string,
		command: string | QueuedTask | PendingSteer,
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

	private settingsFor(id: string): SettingsStore {
		const workspace = this.workspace(id);
		return workspace === this.defaultWorkspace
			? this.defaultSettings
			: new SettingsStore(
					globalHarnessPath("settings.json"),
					resolve(workspace, ".harness/settings.json"),
				);
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
		type === "set-session-title" ||
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
		command.text.trim().length > 0
	);
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
