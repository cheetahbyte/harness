import type {
	AuthEvent,
	AuthInteraction,
	AuthPrompt,
} from "@earendil-works/pi-ai";
import type {
	AuthNotifyEvent,
	AuthPromptEvent,
	AuthType,
	ServerEvent,
} from "../../../shared/src/protocol";

type RegistryProvider = {
	id: string;
	name: string;
	auth: {
		apiKey?: { login?: unknown };
		oauth?: { login?: unknown };
	};
};

export type ModelRegistry = {
	getProviders(): readonly RegistryProvider[];
	getProvider(id: string): RegistryProvider | undefined;
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

type Login = {
	provider: string;
	controller: AbortController;
	prompt?: {
		id: string;
		resolve: (value: string) => void;
		reject: (reason: Error) => void;
	};
};

export class SessionAuthentication {
	private readonly logins = new Map<string, Login>();

	constructor(
		private readonly models: ModelRegistry,
		private readonly publish: (sessionId: string, event: ServerEvent) => void,
	) {}

	start(id: string, providerId: string, authType: AuthType): void {
		if (this.logins.has(id)) {
			this.publish(id, {
				type: "error",
				message: "a login is already in progress",
			});
			return;
		}
		const provider = this.models.getProvider(providerId);
		if (!provider) {
			this.publish(id, {
				type: "error",
				message: `unknown provider ${providerId}`,
			});
			return;
		}
		if (!interactiveAuthTypes(provider.auth).includes(authType)) {
			this.publish(id, {
				type: "error",
				message: `${provider.name} does not support ${authType} login`,
			});
			return;
		}
		const login: Login = {
			provider: providerId,
			controller: new AbortController(),
		};
		this.logins.set(id, login);
		void this.complete(id, login, authType);
	}

	answer(id: string, promptId: string, value: string): void {
		const login = this.logins.get(id);
		const prompt = login?.prompt;
		if (!login || prompt?.id !== promptId) return;
		delete login.prompt;
		prompt.resolve(value);
	}

	cancel(id: string): void {
		const login = this.logins.get(id);
		if (!login) return;
		this.logins.delete(id);
		login.controller.abort();
		login.prompt?.reject(abortError());
		this.publish(id, { type: "auth-cancelled", provider: login.provider });
	}

	private async complete(
		id: string,
		login: Login,
		authType: AuthType,
	): Promise<void> {
		try {
			await this.models.login(login.provider, authType, {
				signal: login.controller.signal,
				prompt: (prompt) => this.prompt(id, login, prompt),
				notify: (event) =>
					this.publish(id, {
						type: "auth-notify",
						notification: serializeNotification(event),
					}),
			});
			if (login.controller.signal.aborted || this.logins.get(id) !== login)
				return;
			await this.models.refresh({ providers: [login.provider] });
			if (this.logins.get(id) === login)
				this.publish(id, { type: "auth-completed", provider: login.provider });
		} catch (error) {
			if (!login.controller.signal.aborted && this.logins.get(id) === login) {
				this.publish(id, {
					type: "error",
					message: error instanceof Error ? error.message : String(error),
				});
				this.publish(id, { type: "auth-cancelled", provider: login.provider });
			}
		} finally {
			if (this.logins.get(id) === login) this.logins.delete(id);
		}
	}

	private prompt(
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
			this.publish(id, {
				type: "auth-prompt",
				prompt: serializePrompt(promptId, prompt),
			});
		});
	}
}

export function interactiveAuthTypes(
	auth: RegistryProvider["auth"],
): AuthType[] {
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
