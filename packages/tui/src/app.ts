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
	ProviderOption,
} from "../../shared/src/protocol";
import { ComposerView } from "./components/composer";
import { FooterView } from "./components/footer";
import { HeaderView } from "./components/header";
import { TranscriptView } from "./components/transcript";
import { WizardView } from "./components/wizard";
import { commandForInput, type TuiState, type WizardState } from "./store";

type WizardFlow =
	| { kind: "login-method"; provider?: string }
	| { kind: "login-provider"; authType: AuthType }
	| { kind: "login-active" }
	| { kind: "model"; provider?: string };

export class TuiApp {
	private readonly root: BoxRenderable;
	private readonly header: HeaderView;
	private readonly transcript: TranscriptView;
	private readonly composer: ComposerView;
	private readonly wizard: WizardView;
	private readonly footer: FooterView;
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
		this.composer = new ComposerView(renderer, {
			submit: (text, followUp) => void this.submit(text, followUp),
			abort: () => this.escape(),
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
		if (!followUp) {
			const login = text.match(/^\/login(?:\s+(\S+))?\s*$/);
			if (login) return this.openLogin(login[1]);
			const model = text.match(/^\/model(?:\s+(\S+))?\s*$/);
			if (model) return this.openModel(model[1]);
		}
		let command = followUp
			? { type: "follow-up" as const, id: crypto.randomUUID(), text }
			: commandForInput(text);
		let id: string | undefined;
		if (command.type === "steer") {
			id = crypto.randomUUID();
			command = { ...command, id };
			this.store.getState().addSteering(id, text);
		}
		if (command.type === "follow-up") {
			id = command.id ?? crypto.randomUUID();
			command = { ...command, id };
			this.store.getState().addFollowUp(id, text);
		}
		try {
			await this.send(command);
		} catch (error) {
			if (id) this.store.getState().removeCommand(id);
			this.store.getState().apply({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private sync() {
		const state = this.store.getState();
		this.header.update(state);
		this.transcript.update(state.entries);
		this.composer.update(state.followUps);
		if (state.wizard !== this.renderedWizard) {
			this.renderedWizard = state.wizard;
			this.renderWizard(state.wizard);
		}
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
		this.openWizard();
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
		this.openWizard();
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
		this.openWizard();
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

	private openWizard() {
		this.composer.setActive(false);
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
			this.store.getState().apply({
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	}
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
