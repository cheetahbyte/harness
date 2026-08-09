import { createStore } from "zustand/vanilla";
import type { ClientCommand, ServerEvent } from "../../shared/src/protocol";

type TranscriptKind =
	| "user"
	| "assistant"
	| "reasoning"
	| "tool-call"
	| "tool-result"
	| "error"
	| "status"
	| "usage"
	| "completed"
	| "aborted";
export type TranscriptEntry = {
	kind: TranscriptKind;
	text: string;
	id?: string;
	error?: boolean;
	active?: boolean;
	pending?: boolean;
};
export type FollowUp = { id: string; text: string; sending: boolean };

/** Projects protocol events for display; it does not own runtime or session behavior. */
export function createTuiStore(sessionId: string) {
	const showStatus = process.env["HARNESS_SHOW_STATUS"] === "1";
	return createStore<TuiState>((set) => {
		const append = (entry: TranscriptEntry) =>
			set((state) => ({ entries: [...finishActive(state.entries), entry] }));
		const delta = (kind: "assistant" | "reasoning", text: string) =>
			set((state) => {
				const last = state.entries.at(-1);
				if (last?.kind === kind && last.active)
					return {
						entries: [
							...state.entries.slice(0, -1),
							{ ...last, text: last.text + text },
						],
					};
				return {
					entries: [
						...finishActive(state.entries),
						{ kind, text, active: true },
					],
				};
			});
		return {
			sessionId,
			entries: [],
			followUps: [],
			running: false,
			status: "ready",
			configuredStatus: "",
			apply(event) {
				if (event.type === "session") return;
				if (event.type === "command") {
					if (event.command === "steer") {
						if (event.state === "started")
							return set((state) => ({
								entries: state.entries.map((entry) =>
									entry.id === event.id ? { ...entry, pending: false } : entry,
								),
							}));
						if (event.state === "replaced")
							return set((state) => ({
								entries: state.entries.filter((entry) => entry.id !== event.id),
							}));
					}
					if (event.command === "follow-up") {
						if (event.state === "started")
							return set((state) => ({
								followUps: state.followUps.map((followUp) =>
									followUp.id === event.id
										? { ...followUp, sending: true }
										: followUp,
								),
							}));
						if (event.state === "finished")
							return set((state) => ({
								followUps: state.followUps.filter(
									(followUp) => followUp.id !== event.id,
								),
							}));
					}
					return;
				}
				if (event.type === "assistant-delta")
					return delta("assistant", event.text);
				if (event.type === "assistant-reasoning-delta")
					return delta("reasoning", event.text);
				if (event.type === "tool-call")
					return append({
						kind: "tool-call",
						text: `${event.name} ${JSON.stringify(event.input)}`,
					});
				if (event.type === "tool-result")
					return append({
						kind: "tool-result",
						text: `${event.name}: ${event.output}`,
						...(event.isError === undefined ? {} : { error: event.isError }),
					});
				if (event.type === "error") {
					set({ running: false });
					return append({ kind: "error", text: event.message, error: true });
				}
				if (event.type === "usage" && showStatus)
					return append({
						kind: "usage",
						text: `in ${event.input} · out ${event.output} · total ${event.totalTokens}`,
					});
				if (event.type === "completed") {
					set({ running: false });
					if (event.durationMs !== undefined)
						return append({
							kind: event.type,
							text: `✶ Noodled for ${formatDuration(event.durationMs)}`,
						});
					return;
				}
				if (event.type === "aborted") {
					set({ running: false });
					if (showStatus) return append({ kind: event.type, text: event.type });
					return;
				}
				if (event.type !== "status") return;
				set((state) => ({
					status: event.text,
					configuredStatus: event.text.startsWith("configured ")
						? event.text
						: state.configuredStatus,
					running: event.text === "running" ? true : state.running,
				}));
				if (showStatus) append({ kind: "status", text: event.text });
			},
			addUser(text) {
				append({ kind: "user", text });
			},
			addSteering(id, text) {
				append({ kind: "user", id, text, pending: true });
			},
			addFollowUp(id, text) {
				set((state) => ({
					followUps: [...state.followUps, { id, text, sending: false }],
				}));
			},
			removeCommand(id) {
				set((state) => ({
					entries: state.entries.filter((entry) => entry.id !== id),
					followUps: state.followUps.filter((followUp) => followUp.id !== id),
				}));
			},
		};
	});
}

export type TuiState = {
	sessionId: string;
	entries: TranscriptEntry[];
	followUps: FollowUp[];
	running: boolean;
	status: string;
	configuredStatus: string;
	apply: (event: ServerEvent) => void;
	addUser: (text: string) => void;
	addSteering: (id: string, text: string) => void;
	addFollowUp: (id: string, text: string) => void;
	removeCommand: (id: string) => void;
};

function finishActive(entries: TranscriptEntry[]): TranscriptEntry[] {
	const last = entries.at(-1);
	if (!last?.active) return entries;
	return [...entries.slice(0, -1), { ...last, active: false }];
}

function formatDuration(durationMs: number): string {
	const seconds = Math.round(durationMs / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function parseModelStatus(status: string): string | undefined {
	// Temporary protocol compatibility adapter; replace when configuration is structured.
	return status.match(/^configured\s+(.+)$/)?.[1];
}

export function commandForInput(text: string): ClientCommand {
	const match = text.match(
		/^\/model\s+(openai-codex|openai-compatible)\s+(\S+)(?:\s+(\S+))?$/,
	);
	if (!match) return { type: "steer", text };
	const [, provider, model, baseUrl] = match;
	if (!provider || !model) return { type: "steer", text };
	return {
		type: "configure",
		provider: provider as "openai-codex" | "openai-compatible",
		model,
		...(baseUrl ? { baseUrl } : {}),
	};
}
