import type { StoreApi } from "zustand/vanilla";
import type { ClientCommand, ModelConfig } from "../../shared/src/protocol";
import type { FollowUp, TranscriptEntry, TuiState, WizardState } from "./store";

export type TuiSnapshot = {
	sessionId: string;
	entries: readonly TranscriptEntry[];
	followUps: readonly FollowUp[];
	running: boolean;
	status: string;
	modelConfig?: ModelConfig;
	wizard: WizardState;
};

export type TuiPluginApi = {
	getState: () => Readonly<TuiSnapshot>;
	subscribe: (listener: (state: Readonly<TuiSnapshot>) => void) => () => void;
	send: (command: ClientCommand) => Promise<void>;
};

export type TuiCommand = {
	name: string;
	description: string;
	run: (args: string, api: TuiPluginApi) => void | Promise<void>;
};

export type TuiPlugin = {
	id: string;
	commands?: readonly TuiCommand[];
	mount?: (api: TuiPluginApi) => (() => void) | undefined;
};

export class TuiPluginHost {
	readonly commands: readonly TuiCommand[];
	private readonly commandByName = new Map<
		string,
		{ command: TuiCommand; pluginId: string }
	>();
	private readonly api: TuiPluginApi;
	private readonly cleanups: (() => void)[] = [];

	constructor(
		store: StoreApi<TuiState>,
		send: (command: ClientCommand) => Promise<void>,
		plugins: readonly TuiPlugin[],
	) {
		this.api = {
			getState: () => snapshot(store.getState()),
			subscribe: (listener) =>
				store.subscribe((state) => listener(snapshot(state))),
			send,
		};
		this.commands = plugins.flatMap((plugin) => plugin.commands ?? []);
		for (const plugin of plugins) {
			for (const command of plugin.commands ?? []) {
				const existing = this.commandByName.get(command.name);
				if (existing)
					throw new Error(
						`duplicate TUI command ${command.name}: ${existing.pluginId}, ${plugin.id}`,
					);
				this.commandByName.set(command.name, { command, pluginId: plugin.id });
			}
			const cleanup = plugin.mount?.(this.api);
			if (cleanup) this.cleanups.push(cleanup);
		}
	}

	async run(input: string): Promise<boolean> {
		const [name, ...arguments_] = input.trim().split(/\s+/);
		const command = this.commandByName.get(name ?? "");
		if (!command) return false;
		await command.command.run(arguments_.join(" "), this.api);
		return true;
	}

	destroy() {
		for (const cleanup of this.cleanups.toReversed()) cleanup();
	}
}

function snapshot(state: TuiState): TuiSnapshot {
	return structuredClone({
		sessionId: state.sessionId,
		entries: state.entries,
		followUps: state.followUps,
		running: state.running,
		status: state.status,
		...(state.modelConfig ? { modelConfig: state.modelConfig } : {}),
		wizard: state.wizard,
	});
}
