import {
	BoxRenderable,
	CliRenderEvents,
	type CliRenderer,
} from "@opentui/core";
import type { StoreApi } from "zustand/vanilla";
import type { ClientCommand } from "../../shared/src/protocol";
import { ComposerView } from "./components/composer";
import { FooterView } from "./components/footer";
import { HeaderView } from "./components/header";
import { TranscriptView } from "./components/transcript";
import { commandForInput, type TuiState } from "./store";

export class TuiApp {
	private readonly root: BoxRenderable;
	private readonly header: HeaderView;
	private readonly transcript: TranscriptView;
	private readonly composer: ComposerView;
	private readonly footer: FooterView;
	private readonly unsubscribe: () => void;

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
			abort: () => void this.send({ type: "abort" }),
		});
		this.footer = new FooterView(renderer);
		this.root.add(this.header.root);
		this.root.add(this.transcript.root);
		this.root.add(this.composer.root);
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
	}

	private async submit(text: string, followUp: boolean) {
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
	}

	private updateLayout = () => {
		const compact = this.root.ctx.height < 9;
		this.header.root.visible = !compact;
		this.footer.root.visible = !compact;
		this.composer.setCompact(compact);
	};
}
