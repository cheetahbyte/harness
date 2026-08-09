import {
	BoxRenderable,
	type CliRenderer,
	InputRenderable,
	InputRenderableEvents,
	type KeyEvent,
	TextRenderable,
} from "@opentui/core";
import type { FollowUp } from "../store";

export class ComposerView {
	readonly root: BoxRenderable;
	private readonly input: InputRenderable;
	private readonly queue: TextRenderable;
	private readonly inputRow: BoxRenderable;
	private hasFollowUps = false;
	private compact = false;

	constructor(
		private readonly renderer: CliRenderer,
		private readonly actions: {
			submit: (text: string, followUp: boolean) => void;
			abort: () => void;
		},
	) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			minHeight: 3,
			marginTop: 1,
			flexDirection: "column",
		});
		this.queue = new TextRenderable(renderer, {
			fg: "#8b8d98",
			marginBottom: 1,
		});
		this.inputRow = new BoxRenderable(renderer, {
			width: "100%",
			height: 3,
			flexDirection: "row",
			alignItems: "center",
			border: ["top", "bottom"],
			borderColor: "#666873",
			paddingLeft: 1,
			paddingRight: 1,
		});
		this.inputRow.add(
			new TextRenderable(renderer, {
				content: "›",
				fg: "#cdd6f4",
				marginRight: 1,
			}),
		);
		this.input = new InputRenderable(renderer, {
			flexGrow: 1,
			placeholder: "",
			textColor: "#cdd6f4",
			backgroundColor: "transparent",
			focusedBackgroundColor: "transparent",
		});
		this.input.on(InputRenderableEvents.ENTER, () => this.submit(false));
		this.inputRow.add(this.input);
		this.root.add(this.queue);
		this.root.add(this.inputRow);
		renderer.keyInput.prependListener("keypress", this.handleKey);
		this.input.focus();
	}

	get value() {
		return this.input.value;
	}

	update(followUps: FollowUp[]) {
		this.hasFollowUps = followUps.length > 0;
		this.queue.content = followUps
			.map(
				(followUp, index) =>
					`${followUp.sending ? "sending" : `${index + 1} queued`} · ${followUp.text}`,
			)
			.join("\n");
		this.syncQueueVisibility();
	}

	setCompact(compact: boolean) {
		this.compact = compact;
		this.syncQueueVisibility();
		this.root.minHeight = compact ? 2 : 3;
		this.root.marginTop = compact ? 0 : 1;
		this.inputRow.height = compact ? 2 : 3;
		this.inputRow.border = compact ? ["top"] : ["top", "bottom"];
	}

	private syncQueueVisibility() {
		this.queue.visible = this.hasFollowUps && !this.compact;
	}

	destroy() {
		this.renderer.keyInput.off("keypress", this.handleKey);
	}

	private handleKey = (key: KeyEvent) => {
		if (key.super && key.name === "c") {
			const text = this.renderer.getSelection()?.getSelectedText();
			if (text) this.renderer.copyToClipboardOSC52(text);
			key.preventDefault();
			return;
		}
		if (key.name === "escape") {
			key.preventDefault();
			this.actions.abort();
			return;
		}
		if (key.name === "return" && (key.option || key.meta)) {
			key.preventDefault();
			this.submit(true);
		}
	};

	private submit(followUp: boolean) {
		const text = this.input.value;
		if (!text.trim()) return;
		this.input.value = "";
		this.actions.submit(text, followUp);
	}
}
