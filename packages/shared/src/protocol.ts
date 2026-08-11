export type AuthType = "oauth" | "api_key";

export type ProviderOption = {
	id: string;
	name: string;
	authTypes: AuthType[];
	configured: boolean;
};

export type ModelOption = {
	provider: string;
	providerName: string;
	id: string;
	name: string;
};

export type SkillOption = { name: string; description: string };

export type ModelConfig = {
	provider: string;
	model: string;
	baseUrl?: string;
};

export type AuthPromptEvent =
	| {
			id: string;
			type: "text" | "secret" | "manual_code";
			message: string;
			placeholder?: string;
	  }
	| {
			id: string;
			type: "select";
			message: string;
			options: { id: string; label: string; description?: string }[];
	  };

export type AuthNotifyEvent =
	| { type: "info"; message: string; links?: { url: string; label?: string }[] }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string }
	| { type: "progress"; message: string };

export type ClientCommand =
	| { type: "prompt"; text: string }
	| { type: "steer"; text: string; id?: string }
	| { type: "follow-up"; text: string; id?: string }
	| ({ type: "configure" } & ModelConfig)
	| { type: "list-providers"; authType?: AuthType }
	| { type: "list-models"; provider?: string }
	| { type: "list-skills" }
	| { type: "set-disable-thinking-blocks"; disabled: boolean }
	| { type: "login"; provider: string; authType: AuthType }
	| { type: "auth-answer"; promptId: string; value: string }
	| { type: "auth-cancel" }
	| { type: "abort" };

export type ServerEvent =
	| { type: "session"; sessionId: string }
	| { type: "assistant-delta"; text: string }
	| { type: "assistant-reasoning-delta"; text: string }
	| { type: "tool-call"; id: string; name: string; input: unknown }
	| {
			type: "tool-result";
			id: string;
			name: string;
			output: string;
			isError?: boolean;
	  }
	| {
			type: "usage";
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			totalTokens: number;
	  }
	| {
			type: "command";
			id: string;
			command: "steer" | "follow-up";
			state: "queued" | "started" | "finished" | "replaced";
	  }
	| { type: "model-config"; config: ModelConfig }
	| { type: "ui-settings"; disableThinkingBlocks: boolean }
	| { type: "status"; text: string }
	| { type: "completed"; durationMs?: number }
	| { type: "aborted" }
	| { type: "providers"; providers: ProviderOption[] }
	| { type: "models"; models: ModelOption[] }
	| { type: "skills"; skills: SkillOption[] }
	| { type: "auth-prompt"; prompt: AuthPromptEvent }
	| { type: "auth-notify"; notification: AuthNotifyEvent }
	| { type: "auth-completed"; provider: string }
	| { type: "auth-cancelled"; provider?: string }
	| { type: "error"; message: string };

/**
 * One line of the event stream. `seq` is the resume cursor: persisted events
 * carry theirs so a reconnect can ask for everything after it, while ephemeral
 * events (auth prompts, provider listings) omit it and are never replayed.
 */
export type StreamLine = { seq?: number; event: ServerEvent };
