import {
	BoxRenderable,
	CliRenderEvents,
	type CliRenderer,
	type SelectOption,
} from "@opentui/core";
import type { StoreApi } from "zustand/vanilla";
import type {
	AuthNotifyEvent,
	AuthPromptEvent,
	AuthType,
	ClientCommand,
	FastCycleEntry,
	ModelOption,
	ProviderOption,
} from "../../shared/src/protocol";
import { type CommandHint, ComposerView } from "./components/composer";
import { FooterView } from "./components/footer";
import { HeaderView } from "./components/header";
import { TranscriptView } from "./components/transcript";
import { WizardView } from "./components/wizard";
import { commandForInput, type TuiState, type WizardState } from "./store";

type WizardFlow =
	| { kind: "login-method"; provider?: string }
	| { kind: "login-provider"; authType: AuthType }
	| { kind: "login-active" }
	| { kind: "model"; provider?: string }
	| { kind: "fast-cycle" };
type AppCommand = CommandHint & {
	kind: "command";
	run: (args: string) => void | Promise<void>;
};

export class TuiApp {
	private readonly root: BoxRenderable;
	private readonly header: HeaderView;
	private readonly transcript: TranscriptView;
	private readonly composer: ComposerView;
	private readonly wizard: WizardView;
	private readonly footer: FooterView;
	private readonly commands: readonly AppCommand[];
	private readonly unsubscribe: () => void;
	private flow: WizardFlow | undefined;
	private renderedWizard: WizardState | undefined;
	private authUrl: string | undefined;

	constructor(
		private readonly renderer: CliRenderer,
		private readonly store: StoreApi<TuiState>,
		private readonly send: (command: ClientCommand) => Promise<void>,
	) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			height: "100%",
			flexDirection: "column",
			padding: 1,
			paddingBottom: 0,
		});
		this.header = new HeaderView(renderer);
		this.transcript = new TranscriptView(renderer);
		this.commands = [
			{
				name: "/login",
				description: "Configure provider authentication",
				kind: "command",
				run: (args) => this.openLogin(args || undefined),
			},
			{
				name: "/model",
				description: "Configure provider and model",
				kind: "command",
				run: (args) =>
					/^\S+\s+\S+(?:\s+\S+)?\s*$/.test(args)
						? this.send(commandForInput(`/model ${args}`))
						: this.openModel(args || undefined),
			},
			{
				name: "/fast-cycle",
				description: "Pick the models Ctrl+P cycles through",
				kind: "command",
				run: () => this.openFastCycle(),
			},
			{
				name: "/session-name",
				description: "Set the current session name",
				kind: "command",
				run: (title) => {
					if (!title.trim()) throw new Error("session name is required");
					return this.send({ type: "set-session-title", title });
				},
			},
			{
				name: "/ack-effects",
				description: "Acknowledge unknown effects from the prior task",
				kind: "command",
				run: async () => {
					const taskId = this.store.getState().activeTaskId;
					if (!taskId) throw new Error("no active task");
					await this.send({ type: "acknowledge-unknown-effects", taskId });
				},
			},
			{
				name: "/supersede",
				description: "Stop the active task and send a replacement",
				kind: "command",
				run: async (text) => {
					if (!text.trim()) throw new Error("replacement text is required");
					const taskId = this.store.getState().activeTaskId;
					await this.send({
						type: "supersede",
						text,
						...(taskId ? { taskId } : {}),
					});
				},
			},
			{
				name: "/resume-queued",
				description: "Resume a blocked queued task",
				kind: "command",
				run: (args) =>
					this.send({ type: "resume-queued", taskId: this.queuedTaskId(args) }),
			},
			{
				name: "/cancel-queued",
				description: "Cancel a blocked queued task",
				kind: "command",
				run: (args) =>
					this.send({ type: "cancel-queued", taskId: this.queuedTaskId(args) }),
			},
			{
				name: "/replace-queued",
				description: "Replace a blocked queued task",
				kind: "command",
				run: (args) => {
					const { taskId, text } = this.queuedReplacement(args);
					return this.send({ type: "replace-queued", taskId, text });
				},
			},
		];
		this.composer = new ComposerView(renderer, this.commands, {
			submit: (text, followUp) => void this.submit(text, followUp),
			abort: () => this.escape(),
			toggleThinking: () => this.toggleThinking(),
			cycleThinkingLevel: () => this.cycleThinkingLevel(),
			cycleModel: () => this.cycleModel(),
		});
		this.wizard = new WizardView(renderer);
		this.footer = new FooterView(renderer);
		this.root.add(this.header.root);
		this.root.add(this.transcript.root);
		this.root.add(this.composer.root);
		this.root.add(this.wizard.root);
		this.root.add(this.footer.root);
		renderer.root.add(this.root);
		renderer.on(CliRenderEvents.RESIZE, this.updateLayout);
		this.unsubscribe = store.subscribe(() => this.sync());
		this.updateLayout();
		this.sync();
	}

	destroy() {
		this.unsubscribe();
		this.renderer.off(CliRenderEvents.RESIZE, this.updateLayout);
		this.composer.destroy();
		this.wizard.destroy();
	}

	private async submit(text: string, followUp: boolean) {
		if (!followUp)
			try {
				if (await this.runCommand(text)) return;
			} catch (error) {
				return this.reportError(error);
			}
		let command: ClientCommand = commandForInput(text);
		let id: string | undefined;
		if (followUp) {
			id = crypto.randomUUID();
			command = { type: "follow-up", id, text };
			this.store.getState().addFollowUp(id, text);
		} else if (command.type === "steer") {
			id = crypto.randomUUID();
			command = { ...command, id };
			this.store.getState().addSteering(id, text);
		}
		try {
			await this.send(command);
		} catch (error) {
			if (id) this.store.getState().removeCommand(id);
			this.reportError(error);
		}
	}

	private reportError(error: unknown) {
		this.store.getState().apply({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	private async runCommand(input: string): Promise<boolean> {
		const [name, ...arguments_] = input.trim().split(/\s+/);
		const command = this.commands.find((candidate) => candidate.name === name);
		if (!command) return false;
		await command.run(arguments_.join(" "));
		return true;
	}

	private queuedTaskId(args: string): string {
		const taskId = args.trim() || this.store.getState().blockedQueueId;
		if (!taskId) throw new Error("blocked queued task id is required");
		return taskId;
	}

	private queuedReplacement(args: string): { taskId: string; text: string } {
		const input = args.trim();
		const defaultTaskId = this.store.getState().blockedQueueId;
		if (defaultTaskId && !input.startsWith(`${defaultTaskId} `)) {
			if (!input) throw new Error("replacement text is required");
			return { taskId: defaultTaskId, text: input };
		}
		const [taskId, ...text] = input.split(/\s+/);
		if (!taskId) throw new Error("blocked queued task id is required");
		if (!text.length) throw new Error("replacement text is required");
		return { taskId, text: text.join(" ") };
	}

	private sync() {
		const state = this.store.getState();
		this.header.update(state);
		this.transcript.setSkills(state.skills.map((skill) => skill.name));
		this.transcript.setPrompts(state.prompts.map((prompt) => prompt.name));
		this.transcript.setDisableThinkingBlocks(state.disableThinkingBlocks);
		this.transcript.update(state.entries);
		this.composer.update(state.followUps);
		/**
		 * One row per name, in the order a leading `/name` resolves: a built-in
		 * command shadows a prompt template, which shadows a skill.
		 */
		const named = new Map<string, CommandHint>();
		for (const command of [
			...this.commands,
			...state.prompts.map((prompt) => ({
				name: `/${prompt.name}`,
				description: prompt.description,
				kind: "prompt" as const,
			})),
			...state.skills.map((skill) => ({
				name: `/${skill.name}`,
				description: skill.description,
				kind: "skill" as const,
			})),
		])
			if (!named.has(command.name)) named.set(command.name, command);
		this.composer.setCommands([...named.values()]);
		this.footer.update(state);
		if (state.wizard !== this.renderedWizard) {
			this.renderedWizard = state.wizard;
			this.renderWizard(state.wizard);
		}
	}

	private toggleThinking() {
		const disabled = !this.store.getState().disableThinkingBlocks;
		this.store.getState().apply({
			type: "ui-settings",
			disableThinkingBlocks: disabled,
		});
		void this.send({
			type: "set-disable-thinking-blocks",
			disabled,
		}).catch((error) => {
			this.store.getState().apply({
				type: "ui-settings",
				disableThinkingBlocks: !disabled,
			});
			this.reportError(error);
		});
	}

	private cycleThinkingLevel() {
		void this.send({ type: "cycle-thinking-level" }).catch((error) => {
			this.reportError(error);
		});
	}

	private cycleModel() {
		void this.send({ type: "cycle-model" }).catch((error) => {
			this.reportError(error);
		});
	}

	private updateLayout = () => {
		const compact = this.root.ctx.height < 9;
		this.header.root.visible = !compact;
		this.footer.root.visible = !compact;
		this.composer.setCompact(compact);
	};

	private openLogin(provider?: string) {
		this.flow = { kind: "login-method", ...(provider ? { provider } : {}) };
		if (provider) {
			this.showNoticeText("Authentication", "Loading provider options…");
			return void this.sendWizard({ type: "list-providers" });
		}
		this.showAuthTypes();
	}

	private openModel(provider?: string) {
		this.flow = { kind: "model", ...(provider ? { provider } : {}) };
		this.showNoticeText("Select model", "Loading configured models…");
		void this.sendWizard({
			type: "list-models",
			...(provider ? { provider } : {}),
		});
	}

	private openFastCycle() {
		this.flow = { kind: "fast-cycle" };
		this.showNoticeText("Fast cycle", "Loading configured models…");
		void this.sendWizard({ type: "list-models" });
	}

	private renderWizard(wizard: WizardState) {
		if (wizard.kind === "idle") return;
		if (wizard.kind === "providers")
			return this.showProviders(wizard.providers);
		if (wizard.kind === "models") return this.showModels(wizard);
		if (wizard.kind === "prompt") return this.showPrompt(wizard.prompt);
		if (wizard.kind === "notice") return this.showNotice(wizard.notification);
		this.closeWizard();
	}

	private showAuthTypes(provider?: ProviderOption) {
		const authTypes =
			provider?.authTypes ?? (["oauth", "api_key"] as AuthType[]);
		if (authTypes.length === 1 && provider) {
			return this.startLogin(provider.id, authTypes[0]);
		}
		this.showSelect(
			provider ? `Sign in to ${provider.name}` : "Select authentication method",
			authTypes.map((authType) => ({
				name:
					authType === "oauth"
						? "Sign in with an account"
						: "Sign in with an API key",
				description:
					authType === "oauth"
						? "Open the provider sign-in flow"
						: "Enter a provider API key",
				value: authType,
			})),
			(option) => {
				const authType = option.value as AuthType;
				if (provider) this.startLogin(provider.id, authType);
				else {
					this.flow = { kind: "login-provider", authType };
					void this.sendWizard({ type: "list-providers", authType });
				}
			},
		);
	}

	private showProviders(providers: ProviderOption[]) {
		const flow = this.flow;
		if (flow?.kind === "login-method") {
			const provider = providers.find((option) => option.id === flow.provider);
			if (!provider)
				return this.showNoticeText(
					"Authentication",
					`Unknown provider: ${flow.provider}`,
				);
			return this.showAuthTypes(provider);
		}
		if (flow?.kind !== "login-provider") return;
		const options = providers.filter((provider) =>
			provider.authTypes.includes(flow.authType),
		);
		if (!options.length)
			return this.showNoticeText(
				"Authentication",
				"No providers support that authentication method.",
			);
		this.showSelect(
			"Select provider to configure",
			options.map((provider) => ({
				name: provider.name,
				description: provider.configured ? "configured" : "unconfigured",
				value: provider.id,
			})),
			(option) => this.startLogin(option.value as string, flow.authType),
			true,
			"inline",
		);
	}

	private showModels(wizard: Extract<WizardState, { kind: "models" }>) {
		const flow = this.flow;
		if (flow?.kind === "fast-cycle") return this.showFastCycle(wizard.models);
		if (flow?.kind !== "model") return;
		const models = wizard.models.filter(
			(model) => !flow.provider || model.provider === flow.provider,
		);
		if (!models.length)
			return this.showNoticeText(
				"Select model",
				"No configured models. Run /login first.",
			);
		this.showSelect(
			"Select model",
			models.map((model) => ({
				name: model.name,
				description: model.providerName,
				value: model,
			})),
			(option) => {
				const model = option.value as (typeof models)[number];
				this.closeWizard();
				void this.sendWizard({
					type: "configure",
					provider: model.provider,
					model: model.id,
				});
			},
			true,
			"inline",
		);
	}

	/** Space-toggled picker over every configured model; the check marks are the cycle. */
	private showFastCycle(models: ModelOption[]) {
		if (!models.length)
			return this.showNoticeText(
				"Fast cycle",
				"No configured models. Run /login first.",
			);
		const { fastCycle } = this.store.getState();
		const levels = new Map(
			fastCycle.map((entry) => [modelKey(entry), entry.thinkingLevel]),
		);
		this.composer.setActive(false);
		this.wizard.show(
			{
				kind: "multiselect",
				title: "Select the models Ctrl+P cycles through",
				options: models.map((model) => {
					const key = modelKey({ provider: model.provider, model: model.id });
					const level = levels.get(key);
					return {
						name: model.name,
						description: level
							? `${model.providerName} · ${level}`
							: model.providerName,
						value: key,
					};
				}),
				selected: fastCycle.map(modelKey),
				searchable: true,
			},
			{
				confirm: (values) => {
					const selected = new Set(values);
					const entries: FastCycleEntry[] = models
						.map((model) => ({
							key: modelKey({ provider: model.provider, model: model.id }),
							model,
						}))
						.filter(({ key }) => selected.has(key))
						.map(({ key, model }) => {
							const level = levels.get(key);
							return {
								provider: model.provider,
								model: model.id,
								...(level ? { thinkingLevel: level } : {}),
							};
						});
					this.closeWizard();
					void this.sendWizard({ type: "set-fast-cycle", entries });
				},
				cancel: () => this.escape(),
			},
		);
	}

	private startLogin(provider: string, authType: AuthType | undefined) {
		if (!authType) return;
		this.authUrl = undefined;
		this.flow = { kind: "login-active" };
		this.showNoticeText("Authentication", "Starting sign-in…");
		void this.sendWizard({ type: "login", provider, authType });
	}

	private showPrompt(prompt: AuthPromptEvent) {
		if (this.flow?.kind !== "login-active") return;
		if (prompt.type === "select") {
			return this.showSelect(
				prompt.message,
				prompt.options.map((option) => ({
					name: option.label,
					description: option.description ?? "",
					value: option.id,
				})),
				(option) =>
					void this.sendWizard({
						type: "auth-answer",
						promptId: prompt.id,
						value: option.value as string,
					}),
			);
		}
		const authUrl = this.authUrl;
		this.composer.setActive(false);
		this.wizard.show(
			{
				kind: "input",
				title: prompt.message,
				...(prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
				...(prompt.type === "secret" ? { secret: true } : {}),
				...(authUrl ? { url: authUrl } : {}),
			},
			{
				submit: (value) =>
					void this.sendWizard({
						type: "auth-answer",
						promptId: prompt.id,
						value,
					}),
				...(authUrl ? { open: () => openBrowser(authUrl) } : {}),
				cancel: () => this.escape(),
			},
		);
	}

	private showNotice(notification: AuthNotifyEvent) {
		if (this.flow?.kind !== "login-active") return;
		const url = notificationUrl(notification);
		if (url) this.authUrl = url;
		this.showNoticeText(
			"Authentication",
			noticeText(notification),
			url ? () => openBrowser(url) : undefined,
		);
	}

	private showNoticeText(title: string, text: string, open?: () => void) {
		this.composer.setActive(false);
		this.wizard.show(
			{ kind: "notice", title, text },
			{ cancel: () => this.escape(), ...(open ? { open } : {}) },
		);
	}

	private showSelect(
		title: string,
		options: SelectOption[],
		select: (option: SelectOption) => void,
		searchable = false,
		descriptionLayout: "inline" | "two-line" = "two-line",
	) {
		this.composer.setActive(false);
		this.wizard.show(
			{
				kind: "select",
				title,
				options,
				...(searchable ? { searchable } : {}),
				...(descriptionLayout === "inline" ? { descriptionLayout } : {}),
			},
			{ select, cancel: () => this.escape() },
		);
	}

	private escape() {
		if (!this.wizard.root.visible) return void this.send({ type: "abort" });
		const cancelLogin = this.flow?.kind === "login-active";
		this.closeWizard();
		if (cancelLogin) void this.sendWizard({ type: "auth-cancel" });
	}

	private closeWizard() {
		this.wizard.hide();
		this.composer.setActive(true);
		this.flow = undefined;
		this.authUrl = undefined;
		this.store.getState().clearWizard();
	}

	private async sendWizard(command: ClientCommand) {
		try {
			await this.send(command);
		} catch (error) {
			this.closeWizard();
			this.reportError(error);
		}
	}
}

function modelKey(config: { provider: string; model: string }): string {
	return `${config.provider}/${config.model}`;
}

function noticeText(notification: AuthNotifyEvent): string {
	if (notification.type === "auth_url")
		return `${notification.instructions ?? "Open this URL:"}\n${notification.url}`;
	if (notification.type === "device_code")
		return `Code: ${notification.userCode}\n${notification.verificationUri}`;
	if (notification.type === "info" && notification.links?.length)
		return `${notification.message}\n${notification.links
			.map((link) => `${link.label ?? link.url}: ${link.url}`)
			.join("\n")}`;
	return notification.message;
}

function notificationUrl(notification: AuthNotifyEvent): string | undefined {
	if (notification.type === "auth_url") return notification.url;
	if (notification.type === "device_code") return notification.verificationUri;
	if (notification.type === "info") return notification.links?.[0]?.url;
	return undefined;
}

function openBrowser(url: string): void {
	const command =
		process.platform === "darwin"
			? ["open", url]
			: process.platform === "win32"
				? ["cmd", "/c", "start", "", url]
				: ["xdg-open", url];
	try {
		void Bun.spawn(command, {
			stdout: "ignore",
			stderr: "ignore",
		}).exited.catch(() => {});
	} catch {}
}
