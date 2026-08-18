import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

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

/** One configured MCP server, as the server menu shows it. */
export type McpServerOption = {
	name: string;
	/** Which file declared it: `~/.config/harnez` or the workspace's `.harnez`. */
	scope: "global" | "project";
	transport: "stdio" | "streamable-http";
	/** Whether the operator has left the server switched on. */
	enabled: boolean;
	/** An enabled server that failed to start or list its tools is not connected. */
	connected: boolean;
	/** Connected, but its child was stopped while idle; the next call revives it. */
	idle: boolean;
	tools: number;
	error?: string;
};

export type PromptOption = { name: string; description: string };

export type ModelConfig = {
	provider: string;
	model: string;
	baseUrl?: string;
	thinkingLevel?: ModelThinkingLevel;
};

export type ImageAttachment = {
	id: string;
	mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
	data: string;
};

type UserInput = { text: string; images?: ImageAttachment[] };

export function displayUserInput(
	text: string,
	images: readonly ImageAttachment[] = [],
): string {
	if (!images.length) return text;
	const body = text.replace(/\[Image #\d+\]/g, "").trim();
	const labels = images.map((_, index) => `[Image #${index + 1}]`).join("\n");
	return body ? `${body}\n\n${labels}` : labels;
}

/** One entry of the `Ctrl+P` fast cycle: a model plus its own reasoning level. */
export type FastCycleEntry = ModelConfig;

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
	| ({ type: "prompt" } & UserInput)
	| ({ type: "steer"; id?: string } & UserInput)
	| ({ type: "follow-up"; id?: string } & UserInput)
	| ({
			type: "enqueue";
	  } & UserInput & {
				id?: string;
				requirePredecessorSuccess?: boolean;
			})
	| ({ type: "supersede"; id?: string; taskId?: string } & UserInput)
	| { type: "resume-queued"; taskId: string }
	| { type: "cancel-queued"; taskId: string }
	| ({ type: "replace-queued"; taskId: string; id?: string } & UserInput)
	| { type: "confirm"; taskId: string; callId: string }
	| { type: "acknowledge-unknown-effects"; taskId: string }
	| ({ type: "configure" } & ModelConfig)
	| { type: "list-providers"; authType?: AuthType }
	| { type: "list-models"; provider?: string }
	| { type: "list-skills" }
	| { type: "list-prompts" }
	| { type: "list-mcp-servers" }
	/** The servers that stay on; every other configured server is switched off. */
	| { type: "set-mcp-enabled"; servers: string[] }
	| { type: "set-session-title"; title: string }
	| { type: "set-disable-thinking-blocks"; disabled: boolean }
	| { type: "login"; provider: string; authType: AuthType }
	| { type: "auth-answer"; promptId: string; value: string }
	| { type: "auth-cancel" }
	| { type: "abort"; taskId?: string }
	| { type: "cycle-thinking-level" }
	| { type: "set-fast-cycle"; entries: FastCycleEntry[] }
	| { type: "cycle-model" };

export type ServerEvent =
	| { type: "session"; sessionId: string }
	| { type: "user"; text: string; id?: string }
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
			/** Provider/model-list estimate in US dollars. Absent on legacy events. */
			costUsd?: number;
	  }
	| {
			type: "context-status";
			liveTokens: number;
			historyTokens: number;
			parkedObservations: number;
			budget: number;
			target: number;
	  }
	| {
			type: "context-compaction";
			sessionId?: string;
			taskId?: string;
			turnId?: number;
			assemblyId?: number;
			evictedCount: number;
			tokensBefore: number;
			tokensAfter: number;
			episodesArchived: number;
			trigger?: "automatic" | "explicit";
			milestone?: string;
	  }
	| { type: "context-budget-error"; estimatedTokens: number; budget: number }
	| {
			type: "command";
			id: string;
			command: "steer" | "follow-up" | "supersede";
			state: "queued" | "started" | "finished" | "cancelled" | "replaced";
	  }
	| {
			type: "task-state";
			taskId: string;
			state: "running" | "cancelling" | "quiescing" | "terminal" | "blocked";
			status?: "completed" | "failed" | "cancelled" | "superseded";
	  }
	| { type: "model-config"; config: ModelConfig }
	| { type: "fast-cycle"; entries: FastCycleEntry[] }
	| { type: "ui-settings"; disableThinkingBlocks: boolean }
	| { type: "status"; text: string }
	| {
			type: "completed";
			durationMs?: number;
			modelDurationMs?: number;
			toolDurationMs?: number;
	  }
	| {
			type: "aborted";
			durationMs?: number;
			modelDurationMs?: number;
			toolDurationMs?: number;
	  }
	| { type: "providers"; providers: ProviderOption[] }
	| { type: "models"; models: ModelOption[] }
	| { type: "skills"; skills: SkillOption[] }
	| { type: "prompts"; prompts: PromptOption[] }
	| { type: "mcp-servers"; servers: McpServerOption[] }
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
