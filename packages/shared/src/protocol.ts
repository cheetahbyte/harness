export type ClientCommand =
	| { type: "prompt"; text: string }
	| { type: "steer"; text: string; id?: string }
	| { type: "follow-up"; text: string; id?: string }
	| {
			type: "configure";
			provider: "openai-codex" | "openai-compatible";
			model: string;
			baseUrl?: string;
	  }
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
	| { type: "status"; text: string }
	| { type: "completed" }
	| { type: "aborted" }
	| { type: "error"; message: string };
