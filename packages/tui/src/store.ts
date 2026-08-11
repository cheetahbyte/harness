import { createStore } from "zustand/vanilla";
import type {
	AuthNotifyEvent,
	AuthPromptEvent,
	ClientCommand,
	ModelConfig,
	ModelOption,
	ProviderOption,
	ServerEvent,
	SkillOption,
} from "../../shared/src/protocol";

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
	detail?: string;
	id?: string;
	error?: boolean;
	active?: boolean;
	pending?: boolean;
};
export type FollowUp = {
	id: string;
	text: string;
	sending: boolean;
	blocked?: boolean;
};
export type WizardState =
	| { kind: "idle" }
	| { kind: "providers"; providers: ProviderOption[] }
	| { kind: "models"; models: ModelOption[] }
	| { kind: "prompt"; prompt: AuthPromptEvent }
	| { kind: "notice"; notification: AuthNotifyEvent }
	| { kind: "completed"; provider: string }
	| { kind: "cancelled"; provider?: string };

/** Projects protocol events for display; it does not own runtime or session behavior. */
export function createTuiStore(sessionId: string, pwd = process.cwd()) {
	const showStatus =
		(process.env["HARNEZ_SHOW_STATUS"] ??
			process.env["HARNESS_SHOW_STATUS"]) === "1";
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
			pwd,
			entries: [],
			followUps: [],
			skills: [],
			running: false,
			status: "ready",
			activeTaskId: undefined,
			blockedQueueId: undefined,
			disableThinkingBlocks: false,
			wizard: { kind: "idle" },
			apply(event) {
				if (event.type === "session") return;
				if (event.type === "task-state") {
					const text = event.status ?? event.state;
					set((state) => {
						let followUps = state.followUps
							.map((followUp) =>
								event.state === "blocked" && followUp.id === event.taskId
									? { ...followUp, blocked: true, sending: false }
									: event.state === "running" && followUp.id === event.taskId
										? { ...followUp, blocked: false, sending: true }
										: followUp,
							)
							.filter(
								(followUp) =>
									event.state !== "terminal" || followUp.id !== event.taskId,
							);
						if (
							event.state === "blocked" &&
							!followUps.some((followUp) => followUp.id === event.taskId)
						)
							followUps = [
								...followUps,
								{
									id: event.taskId,
									text: "queued task",
									sending: false,
									blocked: true,
								},
							];
						const blocked = followUps.filter((followUp) => followUp.blocked);
						return {
							followUps,
							blockedQueueId: blocked.length === 1 ? blocked[0]?.id : undefined,
							running:
								event.state === "running" ||
								event.state === "cancelling" ||
								event.state === "quiescing",
							status: text,
							activeTaskId:
								event.state === "terminal" || event.state === "blocked"
									? undefined
									: event.taskId,
						};
					});
					if (showStatus) append({ kind: "status", text });
					return;
				}
				if (event.type === "skills") return set({ skills: event.skills });
				if (event.type === "providers")
					return set({
						wizard: { kind: "providers", providers: event.providers },
					});
				if (event.type === "models")
					return set({ wizard: { kind: "models", models: event.models } });
				if (event.type === "auth-prompt")
					return set({ wizard: { kind: "prompt", prompt: event.prompt } });
				if (event.type === "auth-notify")
					return set({
						wizard: { kind: "notice", notification: event.notification },
					});
				if (event.type === "auth-completed")
					return set({
						wizard: { kind: "completed", provider: event.provider },
					});
				if (event.type === "auth-cancelled")
					return set({
						wizard: {
							kind: "cancelled",
							...(event.provider ? { provider: event.provider } : {}),
						},
					});
				if (event.type === "command") {
					if (event.command === "steer") {
						if (event.state === "started")
							return set((state) => ({
								entries: state.entries.map((entry) =>
									entry.id === event.id ? { ...entry, pending: false } : entry,
								),
							}));
						if (event.state === "replaced" || event.state === "cancelled")
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
						if (event.state === "finished" || event.state === "cancelled")
							return set((state) => ({
								...withoutFollowUp(state, event.id),
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
						id: event.id,
						text: event.name,
					});
				if (event.type === "tool-result") {
					let merged = false;
					set((state) => {
						const index = state.entries.findLastIndex(
							(entry) => entry.kind === "tool-call" && entry.id === event.id,
						);
						if (index < 0) return state;
						merged = true;
						const entry = state.entries[index];
						if (!entry) return state;
						return {
							entries: state.entries.map((current, currentIndex) =>
								currentIndex === index
									? {
											...current,
											detail: event.output,
											...(event.isError === undefined
												? {}
												: { error: event.isError }),
										}
									: current,
							),
						};
					});
					if (merged) return;
					return append({
						kind: "tool-result",
						text: `${event.name}: ${event.output}`,
						...(event.isError === undefined ? {} : { error: event.isError }),
					});
				}
				if (event.type === "error") {
					set((state) => ({
						running: false,
						wizard:
							state.wizard.kind === "idle"
								? state.wizard
								: { kind: "cancelled" },
					}));
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
				if (event.type === "model-config")
					return set({ modelConfig: event.config });
				if (event.type === "ui-settings")
					return set({
						disableThinkingBlocks: event.disableThinkingBlocks,
					});
				if (event.type !== "status") return;
				set((state) => ({
					status: event.text,
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
					...withoutFollowUp(state, id),
				}));
			},
			clearWizard() {
				set({ wizard: { kind: "idle" } });
			},
		};
	});
}

export type TuiState = {
	sessionId: string;
	pwd: string;
	entries: TranscriptEntry[];
	followUps: FollowUp[];
	skills: SkillOption[];
	running: boolean;
	status: string;
	activeTaskId: string | undefined;
	blockedQueueId: string | undefined;
	modelConfig?: ModelConfig;
	disableThinkingBlocks: boolean;
	wizard: WizardState;
	apply: (event: ServerEvent) => void;
	addUser: (text: string) => void;
	addSteering: (id: string, text: string) => void;
	addFollowUp: (id: string, text: string) => void;
	removeCommand: (id: string) => void;
	clearWizard: () => void;
};

function finishActive(entries: TranscriptEntry[]): TranscriptEntry[] {
	const last = entries.at(-1);
	if (!last?.active) return entries;
	return [...entries.slice(0, -1), { ...last, active: false }];
}

function withoutFollowUp(state: Pick<TuiState, "followUps">, id: string) {
	const followUps = state.followUps.filter((followUp) => followUp.id !== id);
	const blocked = followUps.filter((followUp) => followUp.blocked);
	return {
		followUps,
		blockedQueueId: blocked.length === 1 ? blocked[0]?.id : undefined,
	};
}

function formatDuration(durationMs: number): string {
	const seconds = Math.round(durationMs / 1000);
	const minutes = Math.floor(seconds / 60);
	return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

export function commandForInput(text: string): ClientCommand {
	const match = text.match(/^\/model\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/);
	if (!match) return { type: "steer", text };
	const [, provider, model, baseUrl] = match;
	if (!provider || !model) return { type: "steer", text };
	return {
		type: "configure",
		provider,
		model,
		...(baseUrl ? { baseUrl } : {}),
	};
}
