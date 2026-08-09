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
} from "../../shared/src/protocol";
import { HarnessAgentRuntime } from "./agent-runtime";
import { log } from "./logger";
import {
	createHarnessModels,
	JsonCredentialStore,
	providerModels,
} from "./provider";
import { SessionStore } from "./session-store";
import { globalHarnessPath, SettingsStore } from "./settings-store";
import { CoreTools } from "./tools";

type PendingCommand = { id: string; type: "steer" | "follow-up"; text: string };
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
	listeners: Set<(event: ServerEvent) => void>;
	running?: AbortController;
	followUps: PendingCommand[];
	pendingSteer?: PendingCommand;
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

	constructor(
		readonly store = new SessionStore(),
		workspace = process.cwd(),
		models?: ModelRegistry,
		private readonly settings = new SettingsStore(
			globalHarnessPath("settings.json"),
			resolve(workspace, ".harness/settings.json"),
		),
	) {
		this.credentials = new JsonCredentialStore(globalHarnessPath("auth.json"));
		this.models = models ?? createHarnessModels(this.credentials);
		this.runtime = new HarnessAgentRuntime(
			new CoreTools(resolve(workspace)),
			this.credentials,
			this.models as Models,
		);
	}

	createSession(): string {
		const id = this.store.create();
		this.sessions.set(id, { listeners: new Set(), followUps: [] });
		log.info({ sessionId: id }, "session created");
		return id;
	}

	subscribe(id: string, listener: (event: ServerEvent) => void): () => void {
		const session = this.session(id);
		session.listeners.add(listener);
		for (const event of this.store.events(id)) listener(event);
		const model = this.modelConfig(id);
		if (model)
			listener({
				type: "status",
				text: `configured ${model.provider}/${model.model}`,
			});
		return () => session.listeners.delete(listener);
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
		if (command.type === "abort") {
			log.info({ sessionId: id, running: !!session.running }, "run aborted");
			session.running?.abort();
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
			this.settings.setModelConfig(config);
			this.runtime.forget(id);
			this.emit(id, {
				type: "status",
				text: `configured ${command.provider}/${command.model}`,
			});
			return;
		}
		if (command.type === "follow-up") {
			const pending = this.pending(command);
			if (
				this.runtime.followUp(id, pending.text, {
					onStarted: () =>
						this.emit(id, {
							type: "command",
							id: pending.id,
							command: pending.type,
							state: "started",
						}),
					onFinished: () =>
						this.emit(id, {
							type: "command",
							id: pending.id,
							command: pending.type,
							state: "finished",
						}),
				})
			)
				return this.emit(id, {
					type: "command",
					id: pending.id,
					command: pending.type,
					state: "queued",
				});
			session.followUps.push(pending);
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: pending.type,
				state: "queued",
			});
			this.emit(id, { type: "status", text: "follow-up queued" });
			return;
		}
		if (command.type === "steer") {
			const pending = this.pending(command);
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
				return;
			}
			await this.run(id, pending);
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
		command: string | PendingCommand,
	): Promise<void> {
		const session = this.session(id);
		if (session.running) return; // The steering command has aborted it; its caller owns the next run.
		const controller = new AbortController();
		const startedAt = Date.now();
		session.running = controller;
		const pending = typeof command === "string" ? undefined : command;
		const text = typeof command === "string" ? command : command.text;
		if (pending)
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: pending.type,
				state: "started",
			});
		this.emit(id, { type: "status", text: "running" });
		log.info(
			{
				sessionId: id,
				provider: this.modelConfig(id)?.provider,
				model: this.modelConfig(id)?.model,
				command: pending?.type ?? "prompt",
				textLength: text.length,
			},
			"run started",
		);
		try {
			await this.runtime.run(
				id,
				text,
				this.modelConfig(id),
				controller.signal,
				(event) => this.emit(id, event),
			);
		} catch (error) {
			log.error({ err: error, sessionId: id }, "run failed");
			this.emit(id, {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		delete session.running;
		if (controller.signal.aborted) {
			log.info(
				{ sessionId: id, durationMs: Date.now() - startedAt },
				"run aborted",
			);
			this.emit(id, { type: "aborted" });
			const steer = session.pendingSteer;
			delete session.pendingSteer;
			if (pending?.type === "follow-up")
				this.emit(id, {
					type: "command",
					id: pending.id,
					command: pending.type,
					state: "finished",
				});
			if (steer) await this.run(id, steer);
			return;
		}
		log.info(
			{ sessionId: id, durationMs: Date.now() - startedAt },
			"run finished",
		);
		this.emit(id, { type: "completed", durationMs: Date.now() - startedAt });
		if (pending?.type === "follow-up")
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: pending.type,
				state: "finished",
			});
		const steer = session.pendingSteer;
		delete session.pendingSteer;
		if (steer) {
			await this.run(id, steer);
			return;
		}
		const followUp = session.followUps.shift();
		if (followUp) await this.run(id, followUp);
	}

	private modelConfig(id: string) {
		return this.store.modelConfig(id) ?? this.settings.modelConfig();
	}

	private pending(
		command: Extract<ClientCommand, { type: "steer" | "follow-up" }>,
	): PendingCommand {
		return {
			id: command.id ?? crypto.randomUUID(),
			type: command.type,
			text: command.text,
		};
	}

	private session(id: string): Session {
		if (!this.store.exists(id)) throw new Error("session not found");
		let session = this.sessions.get(id);
		if (!session) {
			session = { listeners: new Set(), followUps: [] };
			this.sessions.set(id, session);
		}
		return session;
	}

	private emit(id: string, event: ServerEvent): void {
		this.publish(id, event);
	}

	private publish(id: string, event: ServerEvent, persist = true): void {
		if (persist) this.store.append(id, event);
		for (const listener of this.session(id).listeners) listener(event);
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

export function serveHarness(
	options: { port?: number; workspace?: string; databasePath?: string } = {},
): ReturnType<typeof Bun.serve> {
	const harness = new HarnessServer(
		new SessionStore(options.databasePath),
		options.workspace,
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
			if (request.method === "POST" && url.pathname === "/sessions")
				return Response.json({ sessionId: harness.createSession() });
			const match = url.pathname.match(
				/^\/sessions\/([^/]+)(?:\/(events|commands))?$/,
			);
			if (!match) return new Response("not found", { status: 404 });
			const [, id, action] = match;
			if (!id) return new Response("not found", { status: 404 });
			try {
				if (request.method === "GET" && action === "events") {
					log.info({ requestId, sessionId: id }, "event stream connected");
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							const write = (event: ServerEvent) =>
								controller.enqueue(
									new TextEncoder().encode(`${JSON.stringify(event)}\n`),
								);
							write({ type: "session", sessionId: id });
							const unsubscribe = harness.subscribe(id, write);
							request.signal.addEventListener(
								"abort",
								() => {
									log.info(
										{ requestId, sessionId: id },
										"event stream disconnected",
									);
									unsubscribe();
									void harness.command(id, { type: "auth-cancel" });
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
					await harness.command(id, (await request.json()) as ClientCommand);
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
