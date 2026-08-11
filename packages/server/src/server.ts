import { EventEmitter } from "node:events";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type {
	AuthEvent,
	AuthInteraction,
	AuthPrompt,
	CredentialStore,
	Models,
} from "@earendil-works/pi-ai";
import type {
	AuthNotifyEvent,
	AuthPromptEvent,
	AuthType,
	ClientCommand,
	ModelOption,
	ProviderOption,
	ServerEvent,
	SkillOption,
	StreamLine,
} from "../../shared/src/protocol";
import { HarnessAgentRuntime } from "./agent-runtime";
import { CapabilityCatalog, CapabilityContext } from "./capability-control";
import { ContextManager, type SubagentResult } from "./context-manager";
import { log } from "./logger";
import {
	createHarnessModels,
	JsonCredentialStore,
	providerModels,
} from "./provider";
import { SessionStore } from "./session-store";
import { globalHarnessPath, SettingsStore } from "./settings-store";
import {
	activateSkill,
	availableSkills,
	type SkillSnapshotEntry,
	scanSkills,
} from "./skills";
import {
	type QueuedTask,
	type SchedulerDecision,
	TaskRuntime,
	TaskScheduler,
	type TaskTerminalStatus,
} from "./task-runtime";
import { tokenCost } from "./token-cost";
import { CoreTools } from "./tools";

type PendingSteer = {
	id: string;
	type: "steer";
	text: string;
};
type RunningTask = {
	controller: AbortController;
	task: TaskRuntime;
	tools: CoreTools;
	skills: SkillSnapshotEntry[];
	prompt: string;
	contextWatermark: number;
};
type SessionEvents = { event: [event: ServerEvent, seq?: number] };
type Login = {
	provider: string;
	controller: AbortController;
	prompt?: {
		id: string;
		resolve: (value: string) => void;
		reject: (reason: Error) => void;
	};
};
type Session = {
	events: EventEmitter<SessionEvents>;
	starting?: Promise<void>;
	running?: RunningTask;
	scheduler: TaskScheduler;
	pendingSteer?: PendingSteer;
	login?: Login;
};

type RegistryProvider = {
	id: string;
	name: string;
	auth: {
		apiKey?: { login?: unknown };
		oauth?: { login?: unknown };
	};
};
type ModelRegistry = {
	getProviders(): readonly RegistryProvider[];
	getProvider(id: string): RegistryProvider | undefined;
	getModels(provider?: string): readonly {
		id: string;
		name: string;
		provider: string;
	}[];
	getModel(provider: string, model: string): unknown;
	checkAuth(provider: string): Promise<{ type: AuthType } | undefined>;
	getAvailable(
		provider?: string,
	): Promise<readonly { id: string; name: string; provider: string }[]>;
	login(
		provider: string,
		type: AuthType,
		interaction: AuthInteraction,
	): Promise<unknown>;
	refresh(options?: { providers?: readonly string[] }): Promise<unknown>;
};

export class HarnessServer {
	private readonly sessions = new Map<string, Session>();
	private readonly runtime: HarnessAgentRuntime;
	private readonly credentials: CredentialStore;
	private readonly models: ModelRegistry;
	private readonly defaultWorkspace: string;
	private readonly context: ContextManager;

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
		this.context = new ContextManager(this.store);
		this.runtime = new HarnessAgentRuntime(
			this.credentials,
			this.models as Models,
			this.store,
			this.context,
			options.contextBudget,
		);
		this.capabilityBudget = 8_000;
	}

	private readonly capabilityBudget: number;

	createSession(workspace = this.defaultWorkspace): string {
		const id = this.store.create(workspacePath(workspace));
		this.sessions.set(id, {
			events: new EventEmitter(),
			scheduler: new TaskScheduler(),
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
		this.emit(id, {
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	async command(id: string, command: ClientCommand): Promise<void> {
		const session = this.session(id);
		log.debug({ sessionId: id, command: command.type }, "command received");
		if (command.type === "list-providers") {
			await this.listProviders(id, command.authType);
			return;
		}
		if (command.type === "list-models") {
			await this.listModels(id, command.provider);
			return;
		}
		if (command.type === "list-skills") {
			await this.listSkills(id);
			return;
		}
		if (command.type === "set-disable-thinking-blocks") {
			this.settingsFor(id).setDisableThinkingBlocks(command.disabled);
			this.publish(
				id,
				{
					type: "ui-settings",
					disableThinkingBlocks: command.disabled,
				},
				false,
			);
			return;
		}
		if (command.type === "login") {
			this.startLogin(id, command.provider, command.authType);
			return;
		}
		if (command.type === "auth-answer") {
			const prompt = session.login?.prompt;
			if (prompt?.id !== command.promptId) return;
			if (session.login) delete session.login.prompt;
			prompt.resolve(command.value);
			return;
		}
		if (command.type === "auth-cancel") {
			this.cancelLogin(id);
			return;
		}
		if (session.starting) await session.starting;
		if (command.type === "abort") {
			log.info({ sessionId: id, running: !!session.running }, "run aborted");
			if (
				command.taskId &&
				session.running &&
				session.running.task.id !== command.taskId
			)
				throw new Error("task is not active");
			if (session.running) {
				if (session.pendingSteer) {
					this.emit(id, {
						type: "command",
						id: session.pendingSteer.id,
						command: "steer",
						state: "cancelled",
					});
					delete session.pendingSteer;
				}
				this.emit(id, {
					type: "task-state",
					taskId: session.running.task.id,
					state: "cancelling",
				});
				session.running.controller.abort();
				await session.running.task.cancel("cancelled");
			}
			return;
		}
		if (command.type === "confirm") {
			if (session.running?.task.id !== command.taskId)
				throw new Error("task is not active");
			session.running.task.confirm(command.callId);
			return;
		}
		if (command.type === "acknowledge-unknown-effects") {
			if (session.running?.task.id !== command.taskId)
				throw new Error("task is not active");
			session.running.task.acknowledgeUnknownPriorEffects();
			return;
		}
		if (command.type === "resume-queued") {
			const queued = session.scheduler.resume(command.taskId);
			this.emit(id, {
				type: "command",
				id: queued.id,
				command: queued.kind,
				state: "queued",
			});
			await this.advance(id, session.scheduler.next());
			return;
		}
		if (command.type === "cancel-queued") {
			const queued = session.scheduler.cancelQueued(command.taskId);
			this.emit(id, {
				type: "command",
				id: queued.id,
				command: queued.kind,
				state: "cancelled",
			});
			await this.advance(id, session.scheduler.next());
			return;
		}
		if (command.type === "replace-queued") {
			const replacementId = command.id ?? crypto.randomUUID();
			const { cancelled, queued } = session.scheduler.replaceQueued(
				command.taskId,
				{ id: replacementId, text: command.text },
				this.contextSequence(id),
			);
			this.emit(id, {
				type: "command",
				id: cancelled.id,
				command: cancelled.kind,
				state: "cancelled",
			});
			this.emit(id, {
				type: "command",
				id: queued.id,
				command: queued.kind,
				state: "queued",
			});
			await this.advance(id, session.scheduler.next());
			return;
		}
		if (command.type === "configure") {
			if (session.running) throw new Error("cannot change model while running");
			const config = {
				provider: command.provider,
				model: command.model,
				...(command.baseUrl ? { baseUrl: command.baseUrl } : {}),
			};
			providerModels(config, this.credentials, this.models as Models);
			this.store.setModelConfig(id, config);
			this.settingsFor(id).setModelConfig(config);
			this.runtime.forget(id);
			this.emit(id, { type: "model-config", config });
			return;
		}
		if (command.type === "follow-up" || command.type === "enqueue") {
			const pending = session.scheduler.enqueue(
				{ id: command.id ?? crypto.randomUUID(), text: command.text },
				this.contextSequence(id),
				{
					requirePredecessorSuccess:
						command.type === "enqueue" &&
						command.requirePredecessorSuccess === true,
				},
			);
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: pending.kind,
				state: "queued",
			});
			this.emit(id, { type: "status", text: "follow-up queued" });
			return;
		}
		if (command.type === "supersede") {
			if (!session.running) {
				const commandId = command.id ?? crypto.randomUUID();
				await this.run(id, {
					id: commandId,
					kind: "supersede",
					state: "ready",
					userInput: {
						id: commandId,
						text: command.text,
					},
					submissionWatermark: this.contextSequence(id),
					requirePredecessorSuccess: false,
				});
				return;
			}
			if (command.taskId && command.taskId !== session.running.task.id)
				throw new Error("task is not active");
			if (session.pendingSteer) {
				this.emit(id, {
					type: "command",
					id: session.pendingSteer.id,
					command: "steer",
					state: "replaced",
				});
				delete session.pendingSteer;
			}
			const { queued: pending, replaced } = session.scheduler.requestSupersede(
				session.running.task.id,
				{ id: command.id ?? crypto.randomUUID(), text: command.text },
				this.contextSequence(id),
			);
			if (replaced)
				this.emit(id, {
					type: "command",
					id: replaced.id,
					command: "supersede",
					state: "replaced",
				});
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: "supersede",
				state: "queued",
			});
			this.emit(id, {
				type: "task-state",
				taskId: session.running.task.id,
				state: "cancelling",
			});
			session.running.controller.abort();
			await session.running.task.cancel("superseded");
			return;
		}
		if (command.type === "steer") {
			const pending: PendingSteer = {
				id: command.id ?? crypto.randomUUID(),
				type: "steer",
				text: command.text,
			};
			if (session.running) {
				if (
					this.runtime.steer(id, pending.text, {
						onStarted: () =>
							this.emit(id, {
								type: "command",
								id: pending.id,
								command: pending.type,
								state: "started",
							}),
						onFinished: () => {},
						onReplaced: () =>
							this.emit(id, {
								type: "command",
								id: pending.id,
								command: pending.type,
								state: "replaced",
							}),
					})
				)
					return;
				if (session.pendingSteer)
					this.emit(id, {
						type: "command",
						id: session.pendingSteer.id,
						command: "steer",
						state: "replaced",
					});
				session.pendingSteer = pending;
				this.emit(id, {
					type: "status",
					text: "steering after current turn",
				});
				session.running.controller.abort();
				return;
			}
			await this.run(id, pending);
			return;
		}
		if (session.running) {
			const pending = session.scheduler.enqueue(
				{ id: crypto.randomUUID(), text: command.text },
				this.contextSequence(id),
			);
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: "follow-up",
				state: "queued",
			});
			return;
		}
		await this.run(id, command.text);
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

	private startLogin(id: string, providerId: string, authType: AuthType): void {
		const session = this.session(id);
		if (session.login) {
			this.publish(
				id,
				{ type: "error", message: "a login is already in progress" },
				false,
			);
			return;
		}
		const provider = this.models.getProvider(providerId);
		if (!provider) {
			this.publish(
				id,
				{ type: "error", message: `unknown provider ${providerId}` },
				false,
			);
			return;
		}
		if (!interactiveAuthTypes(provider.auth).includes(authType)) {
			this.publish(
				id,
				{
					type: "error",
					message: `${provider.name} does not support ${authType} login`,
				},
				false,
			);
			return;
		}
		const login: Login = {
			provider: providerId,
			controller: new AbortController(),
		};
		session.login = login;
		void this.completeLogin(id, login, authType);
	}

	private async completeLogin(
		id: string,
		login: Login,
		authType: AuthType,
	): Promise<void> {
		try {
			await this.models.login(login.provider, authType, {
				signal: login.controller.signal,
				prompt: (prompt) => this.promptForLogin(id, login, prompt),
				notify: (notification) =>
					this.publish(
						id,
						{
							type: "auth-notify",
							notification: serializeNotification(notification),
						},
						false,
					),
			});
			if (login.controller.signal.aborted || this.session(id).login !== login)
				return;
			await this.models.refresh({ providers: [login.provider] });
			if (this.session(id).login === login)
				this.publish(
					id,
					{ type: "auth-completed", provider: login.provider },
					false,
				);
		} catch (error) {
			if (
				!login.controller.signal.aborted &&
				this.session(id).login === login
			) {
				this.publish(
					id,
					{
						type: "error",
						message: error instanceof Error ? error.message : String(error),
					},
					false,
				);
				this.publish(
					id,
					{ type: "auth-cancelled", provider: login.provider },
					false,
				);
			}
		} finally {
			if (this.session(id).login === login) delete this.session(id).login;
		}
	}

	private promptForLogin(
		id: string,
		login: Login,
		prompt: AuthPrompt,
	): Promise<string> {
		if (login.controller.signal.aborted) return Promise.reject(abortError());
		if (login.prompt)
			return Promise.reject(new Error("login already has a pending prompt"));
		const promptId = crypto.randomUUID();
		return new Promise((resolve, reject) => {
			login.prompt = { id: promptId, resolve, reject };
			const cancel = () => {
				if (login.prompt?.id !== promptId) return;
				delete login.prompt;
				reject(abortError());
			};
			login.controller.signal.addEventListener("abort", cancel, { once: true });
			prompt.signal?.addEventListener("abort", cancel, { once: true });
			this.publish(
				id,
				{ type: "auth-prompt", prompt: serializePrompt(promptId, prompt) },
				false,
			);
		});
	}

	private cancelLogin(id: string): void {
		const session = this.session(id);
		const login = session.login;
		if (!login) return;
		delete session.login;
		login.controller.abort();
		login.prompt?.reject(abortError());
		this.publish(
			id,
			{ type: "auth-cancelled", provider: login.provider },
			false,
		);
	}

	private async run(
		id: string,
		command: string | QueuedTask | PendingSteer,
		predecessor?: TaskRuntime,
		resume?: RunningTask,
	): Promise<void> {
		const session = this.session(id);
		if (session.running) return;
		const controller = new AbortController();
		const startedAt = Date.now();
		const pending = typeof command === "string" ? undefined : command;
		const text =
			typeof command === "string"
				? command
				: "userInput" in command
					? command.userInput.text
					: command.text;
		const pendingType = pending
			? "kind" in pending
				? pending.kind
				: pending.type
			: undefined;
		let running: RunningTask;
		if (resume) {
			running = { ...resume, controller, prompt: text };
			session.running = running;
			session.scheduler.activate(running.task);
		} else {
			let releaseStarting!: () => void;
			session.starting = new Promise<void>(
				(resolve) => (releaseStarting = resolve),
			);
			try {
				running = await this.createTask(
					id,
					text,
					controller,
					predecessor,
					pending && "submissionWatermark" in pending
						? pending.submissionWatermark
						: undefined,
				);
				session.running = running;
				session.scheduler.activate(running.task);
			} finally {
				delete session.starting;
				releaseStarting();
			}
		}
		if (pending)
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: pendingType ?? "follow-up",
				state: "started",
			});
		this.emit(id, { type: "status", text: "running" });
		this.emit(id, {
			type: "task-state",
			taskId: running.task.id,
			state: "running",
		});
		log.info(
			{
				sessionId: id,
				provider: this.modelConfig(id)?.provider,
				model: this.modelConfig(id)?.model,
				command: pendingType ?? "prompt",
				textLength: text.length,
			},
			"run started",
		);
		try {
			await this.runtime.run(
				id,
				running.prompt,
				this.modelConfig(id),
				running.tools,
				running.task,
				running.skills,
				controller.signal,
				(event) => this.emit(id, event),
			);
		} catch (error) {
			log.error({ err: error, sessionId: id }, "run failed");
			this.emit(id, {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
			const terminalMessageIds = this.context.terminalizeTask(
				id,
				running.contextWatermark,
			);
			if (!running.task.result()) {
				running.task.finish({
					status: "failed",
					error: {
						code: "TASK_FAILED",
						message: error instanceof Error ? error.message : String(error),
					},
					terminalMessageIds,
				});
			} else running.task.addTerminalMessageIds(terminalMessageIds);
			delete session.running;
			const terminalStatus = running.task.result()?.status ?? "failed";
			this.completeTask(id, running.task, terminalStatus);
			this.finishPending(id, pending);
			await this.advance(id, session.scheduler.settle(running.task));
			return;
		}
		delete session.running;
		if (controller.signal.aborted) {
			const steer = session.pendingSteer;
			if (
				steer &&
				!session.scheduler.hasPendingSupersede() &&
				!running.task.result()
			) {
				delete session.pendingSteer;
				this.emit(id, { type: "aborted" });
				await this.run(id, steer, undefined, running);
				return;
			}
			const terminalMessageIds = this.context.terminalizeTask(
				id,
				running.contextWatermark,
			);
			if (!running.task.result()) {
				await running.task.cancel(
					session.scheduler.hasPendingSupersede() ? "superseded" : "cancelled",
					terminalMessageIds,
				);
			} else running.task.addTerminalMessageIds(terminalMessageIds);
			log.info(
				{ sessionId: id, durationMs: Date.now() - startedAt },
				"run aborted",
			);
			this.emit(id, { type: "aborted" });
			const terminalStatus = running.task.result()?.status ?? "cancelled";
			this.completeTask(id, running.task, terminalStatus);
			this.finishPending(id, pending);
			await this.advance(id, session.scheduler.settle(running.task));
			return;
		}
		const terminalMessageIds = this.context.terminalizeTask(
			id,
			running.contextWatermark,
		);
		running.task.finish({ status: "completed", terminalMessageIds });
		log.info(
			{ sessionId: id, durationMs: Date.now() - startedAt },
			"run finished",
		);
		this.emit(id, { type: "completed", durationMs: Date.now() - startedAt });
		this.completeTask(id, running.task, "completed");
		this.finishPending(id, pending);
		await this.advance(id, session.scheduler.settle(running.task));
	}

	private async createTask(
		id: string,
		text: string,
		controller: AbortController,
		predecessor?: TaskRuntime,
		submissionWatermark?: number,
	): Promise<RunningTask> {
		const bindingGeneration = crypto.randomUUID();
		const contextWatermark = this.store.contextItems(id).at(-1)?.sequence ?? 0;
		const tools = new CoreTools(this.workspace(id));
		const scanned = await scanSkills(
			this.workspace(id),
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
		const context = new CapabilityContext(
			{
				model: this.modelConfig(id),
				userInput: text,
				...(predecessor
					? { predecessorDigest: predecessor.digest(snapshot) }
					: {}),
			},
			(base, items) => ({
				base,
				capabilityContext: items.map(({ content }) => content),
			}),
			this.capabilityBudget,
			512,
		);
		const predecessorDigest = predecessor?.digest(snapshot);
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
			modelId: this.modelConfig(id)?.model ?? "unconfigured",
			serializerVersion: "pi-json-v1",
			method: "conservative_estimate" as const,
			count: (request: unknown) => tokenCost(request),
		};
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
		const selected = new Set<string>();
		const prompt = text
			.replace(
				/(^|\s)\/([a-z0-9-]+)(?=$|\s|[.,!?;:])/g,
				(match, prefix: string, name: string) => {
					if (
						scanned.discoverable.some((entry) => entry.capability.name === name)
					) {
						selected.add(name);
						return prefix;
					}
					return match;
				},
			)
			.trim();
		for (const name of selected) {
			const entry = scanned.discoverable.find(
				(candidate) => candidate.capability.name === name,
			);
			if (!entry) continue;
			const ref = snapshot.reference(entry.capability.id);
			const admission = await activateSkill(entry, ref, context, accountant);
			if (admission.status === "rejected")
				throw new Error(JSON.stringify(admission));
		}
		return {
			controller,
			task,
			tools,
			skills: scanned.discoverable,
			prompt,
			contextWatermark,
		};
	}

	private completeTask(
		id: string,
		task: TaskRuntime,
		status: TaskTerminalStatus,
	): void {
		this.runtime.forget(id);
		this.store.appendTaskLedger(id, task.id, task.ledger());
		this.store.recordTaskTerminal(id, task.id, status, task.startedAt);
		this.emit(id, {
			type: "task-state",
			taskId: task.id,
			state: "terminal",
			status,
		});
	}

	private finishPending(id: string, pending?: QueuedTask | PendingSteer): void {
		if (!pending) return;
		this.emit(id, {
			type: "command",
			id: pending.id,
			command: "kind" in pending ? pending.kind : pending.type,
			state: "finished",
		});
	}

	private async advance(
		id: string,
		decision: SchedulerDecision | undefined,
	): Promise<void> {
		const session = this.session(id);
		const steer = session.pendingSteer;
		delete session.pendingSteer;
		if (steer) return await this.run(id, steer);
		if (!decision) return;
		if (decision.state === "blocked") {
			this.emit(id, {
				type: "task-state",
				taskId: decision.queued.id,
				state: "blocked",
			});
			return;
		}
		await this.run(id, decision.queued, decision.predecessor);
	}

	private modelConfig(id: string) {
		return this.store.modelConfig(id) ?? this.settingsFor(id).modelConfig();
	}

	private contextSequence(id: string): number {
		return this.store.contextItems(id).at(-1)?.sequence ?? 0;
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
			session = {
				events: new EventEmitter(),
				scheduler: new TaskScheduler(),
			};
			this.sessions.set(id, session);
		}
		return session;
	}

	private emit(id: string, event: ServerEvent): void {
		this.publish(id, event);
	}

	private publish(id: string, event: ServerEvent, persist = true): void {
		const seq = persist ? this.store.append(id, event) : undefined;
		this.session(id).events.emit("event", event, seq);
	}
}

function interactiveAuthTypes(auth: RegistryProvider["auth"]): AuthType[] {
	return [
		...(auth.oauth?.login ? (["oauth"] as const) : []),
		...(auth.apiKey?.login ? (["api_key"] as const) : []),
	];
}

function serializePrompt(id: string, prompt: AuthPrompt): AuthPromptEvent {
	if (prompt.type === "select")
		return {
			id,
			type: prompt.type,
			message: prompt.message,
			options: prompt.options.map((option) => ({ ...option })),
		};
	return {
		id,
		type: prompt.type,
		message: prompt.message,
		...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
	};
}

function serializeNotification(event: AuthEvent): AuthNotifyEvent {
	if (event.type === "info")
		return {
			type: event.type,
			message: event.message,
			...(event.links
				? { links: event.links.map((link) => ({ ...link })) }
				: {}),
		};
	if (event.type === "device_code")
		return {
			type: event.type,
			userCode: event.userCode,
			verificationUri: event.verificationUri,
		};
	return event;
}

function abortError(): Error {
	return new DOMException("login cancelled", "AbortError");
}

function workspacePath(path: string): string {
	const workspace = resolve(path);
	try {
		if (statSync(workspace).isDirectory()) return workspace;
	} catch {}
	throw new Error("workspace must be an existing directory");
}

export function serveHarness(
	options: {
		port?: number;
		workspace?: string;
		databasePath?: string;
		contextBudget?: number;
	} = {},
): ReturnType<typeof Bun.serve> {
	const harness = new HarnessServer(
		new SessionStore(options.databasePath),
		options.workspace,
		undefined,
		undefined,
		options.contextBudget === undefined
			? {}
			: { contextBudget: options.contextBudget },
	);
	return Bun.serve({
		port: options.port ?? 7432,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const requestId = crypto.randomUUID();
			log.debug(
				{ requestId, method: request.method, path: url.pathname },
				"http request",
			);
			if (request.method === "POST" && url.pathname === "/sessions") {
				try {
					return Response.json({
						sessionId: harness.createSession(await sessionWorkspace(request)),
					});
				} catch (error) {
					return Response.json(
						{ error: error instanceof Error ? error.message : String(error) },
						{ status: 400 },
					);
				}
			}
			const match = url.pathname.match(
				/^\/sessions\/([^/]+)(?:\/(events|commands|context|subagent-results))?$/,
			);
			if (!match) return new Response("not found", { status: 404 });
			const [, id, action] = match;
			if (!id) return new Response("not found", { status: 404 });
			try {
				if (request.method === "POST" && action === "subagent-results") {
					const handoff = parseSubagentHandoff(await request.json());
					return Response.json(
						harness.acceptSubagentResult(
							id,
							handoff.result,
							handoff.subagentId,
						),
						{ status: 201 },
					);
				}
				if (request.method === "GET" && action === "context")
					return Response.json(harness.contextStatus(id));
				if (request.method === "GET" && action === "events") {
					// A reconnecting client resumes after the last cursor it applied.
					const from = Math.max(0, Number(url.searchParams.get("from")) || 0);
					log.info(
						{ requestId, sessionId: id, from },
						"event stream connected",
					);
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							const encoder = new TextEncoder();
							const write = (event: ServerEvent, seq?: number) =>
								controller.enqueue(
									encoder.encode(
										`${JSON.stringify(
											seq === undefined
												? ({ event } satisfies StreamLine)
												: ({ seq, event } satisfies StreamLine),
										)}\n`,
									),
								);
							write({ type: "session", sessionId: id });
							const unsubscribe = harness.subscribe(id, write, from);
							const heartbeat = setInterval(() => {
								try {
									controller.enqueue(encoder.encode("\n"));
								} catch {
									clearInterval(heartbeat);
								}
							}, 30_000);
							request.signal.addEventListener(
								"abort",
								() => {
									log.info(
										{ requestId, sessionId: id },
										"event stream disconnected",
									);
									clearInterval(heartbeat);
									unsubscribe();
									// Reconnects make disconnects routine, so this must never
									// escape as an unhandled rejection.
									void harness
										.command(id, { type: "auth-cancel" })
										.catch((error) =>
											log.error(
												{ err: error, requestId, sessionId: id },
												"auth cancel on disconnect failed",
											),
										);
									controller.close();
								},
								{ once: true },
							);
						},
					});
					return new Response(stream, {
						headers: {
							"content-type": "application/x-ndjson",
							"cache-control": "no-cache",
						},
					});
				}
				if (request.method === "POST" && action === "commands") {
					harness.workspace(id); // Throws 404 for unknown sessions before detaching.
					void harness
						.command(id, (await request.json()) as ClientCommand)
						.catch((error) => {
							log.error(
								{ err: error, requestId, sessionId: id },
								"command failed",
							);
							harness.reportError(id, error);
						});
					return new Response(null, { status: 202 });
				}
				if (request.method === "GET" && !action)
					return Response.json({
						sessionId: id,
						events: harness.store.events(id),
					});
			} catch (error) {
				log.error(
					{ err: error, requestId, sessionId: id },
					"http request failed",
				);
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 404 },
				);
			}
			return new Response("not found", { status: 404 });
		},
	});
}

async function sessionWorkspace(request: Request): Promise<string | undefined> {
	const text = await request.text();
	if (!text) return undefined;
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error("session body must be valid JSON");
	}
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new Error("session body must be an object");
	const cwd = (body as { cwd?: unknown }).cwd;
	if (cwd !== undefined && (typeof cwd !== "string" || !cwd))
		throw new Error("cwd must be a non-empty string");
	return cwd;
}

function parseSubagentHandoff(value: unknown): {
	subagentId: string;
	result: SubagentResult;
} {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid subagent result");
	const input = value as Record<string, unknown>;
	const subagentId = input["subagentId"];
	if (typeof subagentId !== "string" || !subagentId.trim())
		throw new Error("invalid subagent id");
	const resultValue = input["result"];
	if (
		!resultValue ||
		typeof resultValue !== "object" ||
		Array.isArray(resultValue)
	)
		throw new Error("invalid subagent result");
	if (input["trace"] !== undefined)
		throw new Error("subagent traces must remain external");
	const result = resultValue as Record<string, unknown>;
	const status = result["status"];
	if (status !== "completed" && status !== "blocked" && status !== "failed")
		throw new Error("invalid subagent status");
	return {
		subagentId,
		result: {
			status,
			findings: stringArray(result["findings"], "findings"),
			decisions: stringArray(result["decisions"], "decisions"),
			changedFiles: stringArray(result["changedFiles"], "changed files"),
			verification: stringArray(result["verification"], "verification"),
			unresolvedIssues: stringArray(
				result["unresolvedIssues"],
				"unresolved issues",
			),
			artifactRefs: stringArray(result["artifactRefs"], "artifact refs"),
		},
	};
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		throw new Error(`invalid subagent ${name}`);
	return value as string[];
}
