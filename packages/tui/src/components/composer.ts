import {
	BoxRenderable,
	type CliRenderer,
	InputRenderable,
	InputRenderableEvents,
	type KeyEvent,
	TextRenderable,
} from "@opentui/core";
import type { FollowUp } from "../store";

const slashCommands = [
	{ name: "/model", description: "Configure provider and model" },
];

export class ComposerView {
	readonly root: BoxRenderable;
	private readonly input: InputRenderable;
	private readonly queue: TextRenderable;
	private readonly suggestions: TextRenderable;
	private readonly inputRow: BoxRenderable;
	private hasFollowUps = false;
	private compact = false;
	private matches: (typeof slashCommands)[number][] = [];
	private selectedSuggestion = 0;

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
		this.suggestions = new TextRenderable(renderer, {
			fg: "#8b8d98",
			marginBottom: 1,
			visible: false,
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
		this.input.on(InputRenderableEvents.INPUT, (text: string) =>
			this.syncSuggestions(text),
		);
		this.inputRow.add(this.input);
		this.root.add(this.queue);
		this.root.add(this.suggestions);
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
		this.syncSuggestions(this.input.value);
	}

	private syncQueueVisibility() {
		this.queue.visible = this.hasFollowUps && !this.compact;
	}

	destroy() {
		this.renderer.keyInput.off("keypress", this.handleKey);
	}

	private handleKey = (key: KeyEvent) => {
		if (this.suggestions.visible) {
			if (key.name === "up" || key.name === "down") {
				const direction = key.name === "up" ? -1 : 1;
				this.selectedSuggestion =
					(this.selectedSuggestion + direction + this.matches.length) %
					this.matches.length;
				this.renderSuggestions();
				key.preventDefault();
				return;
			}
			if (key.name === "tab" || key.name === "return") {
				this.input.value = `${this.matches[this.selectedSuggestion]?.name ?? ""} `;
				key.preventDefault();
				return;
			}
		}
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

	private syncSuggestions(text: string) {
		const query = text.match(/^\/\S*$/)?.[0];
		this.matches = query
			? slashCommands.filter((command) => command.name.startsWith(query))
			: [];
		this.selectedSuggestion = Math.min(
			this.selectedSuggestion,
			Math.max(0, this.matches.length - 1),
		);
		this.suggestions.visible = !this.compact && this.matches.length > 0;
		this.renderSuggestions();
	}

	private renderSuggestions() {
		this.suggestions.content = this.matches
			.map(
				(command, index) =>
					`${index === this.selectedSuggestion ? "›" : " "} ${command.name}  ${command.description}`,
			)
			.join("\n");
	}
}
