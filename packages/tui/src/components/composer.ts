import {
	BoxRenderable,
	type CliRenderer,
	InputRenderable,
	InputRenderableEvents,
	type KeyEvent,
	SyntaxStyle,
	TextRenderable,
} from "@opentui/core";
import { slashCommandPattern } from "../../../shared/src/slash-command";
import type { FollowUp } from "../store";

const ACCENT = "#89b4fa";
const SUGGESTION_WINDOW_SIZE = 5;
type CommandHint = {
	name: string;
	description: string;
	kind: "command" | "skill";
};

export class ComposerView {
	readonly root: BoxRenderable;
	private readonly input: InputRenderable;
	private readonly skillStyle = SyntaxStyle.fromStyles({
		skill: { fg: ACCENT },
	});
	private readonly skillStyleId = this.skillStyle.getStyleId("skill");
	private readonly queue: TextRenderable;
	private readonly suggestions: BoxRenderable;
	private readonly suggestionRows: {
		root: BoxRenderable;
		indicator: TextRenderable;
		name: TextRenderable;
		description: TextRenderable;
	}[];
	private readonly inputRow: BoxRenderable;
	private commands: readonly CommandHint[];
	private hasFollowUps = false;
	private compact = false;
	private matches: CommandHint[] = [];
	private selectedSuggestion = 0;
	private suggestionOffset = 0;
	private suggestionStart = 0;

	constructor(
		private readonly renderer: CliRenderer,
		commands: readonly CommandHint[],
		private readonly actions: {
			submit: (text: string, followUp: boolean) => void;
			abort: () => void;
			toggleThinking: () => void;
			cycleThinkingLevel: () => void;
		},
	) {
		this.commands = commands;
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
		this.suggestions = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "column",
			marginBottom: 1,
			visible: false,
		});
		this.suggestionRows = Array.from({ length: SUGGESTION_WINDOW_SIZE }, () => {
			const root = new BoxRenderable(renderer, {
				width: "100%",
				height: 1,
				flexDirection: "row",
				visible: false,
			});
			const indicator = new TextRenderable(renderer, {
				width: 2,
				fg: "#8b8d98",
			});
			const name = new TextRenderable(renderer, {
				fg: ACCENT,
				flexShrink: 0,
				marginRight: 2,
			});
			const description = new TextRenderable(renderer, {
				flexGrow: 1,
				fg: "#8b8d98",
				truncate: true,
			});
			root.add(indicator);
			root.add(name);
			root.add(description);
			this.suggestions.add(root);
			return { root, indicator, name, description };
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
				fg: ACCENT,
				marginRight: 1,
			}),
		);
		this.input = new InputRenderable(renderer, {
			flexGrow: 1,
			placeholder: "",
			textColor: "#a6adc8",
			backgroundColor: "transparent",
			focusedBackgroundColor: "transparent",
			syntaxStyle: this.skillStyle,
		});
		this.input.on(InputRenderableEvents.ENTER, () => this.submit(false));
		this.input.on(InputRenderableEvents.INPUT, (text: string) => {
			this.highlightSkills(text);
			this.syncSuggestions(text);
		});
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

	setActive(active: boolean) {
		this.root.visible = active;
		if (active) this.input.focus();
		else this.input.blur();
	}

	setCommands(commands: readonly CommandHint[]) {
		this.commands = commands;
		this.highlightSkills(this.input.value);
		this.syncSuggestions(this.input.value);
	}

	update(followUps: FollowUp[]) {
		this.hasFollowUps = followUps.length > 0;
		this.queue.content = followUps
			.map(
				(followUp, index) =>
					`${followUp.blocked ? `blocked (${followUp.id})` : followUp.sending ? "sending" : `${index + 1} queued`} · ${followUp.text}`,
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
		this.skillStyle.destroy();
	}

	private handleKey = (key: KeyEvent) => {
		if (key.defaultPrevented) return;
		if (key.ctrl && key.name === "t") {
			this.actions.toggleThinking();
			key.preventDefault();
			return;
		}
		if (key.shift && key.name === "tab") {
			this.actions.cycleThinkingLevel();
			key.preventDefault();
			return;
		}
		if (this.suggestions.visible) {
			if (key.name === "up" || key.name === "down") {
				const direction = key.name === "up" ? -1 : 1;
				this.selectedSuggestion =
					(this.selectedSuggestion + direction + this.matches.length) %
					this.matches.length;
				this.ensureSelectionVisible();
				this.renderSuggestions();
				key.preventDefault();
				return;
			}
			if (key.name === "tab") {
				this.replaceSuggestion(" ");
				this.syncSuggestions(this.input.value);
				key.preventDefault();
				return;
			}
			if (key.name === "return") {
				this.replaceSuggestion("");
				this.syncSuggestions(this.input.value);
				key.preventDefault();
				this.submit(false);
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
		const match = text.match(/(^|\s)(\/[a-z0-9-]*)$/);
		const query = match?.[2];
		this.suggestionStart = query ? text.length - query.length : text.length;
		this.matches = query
			? this.commands.filter(
					(command) =>
						command.name.startsWith(query) &&
						(this.suggestionStart === 0 || command.kind === "skill"),
				)
			: [];
		this.selectedSuggestion = Math.min(
			this.selectedSuggestion,
			Math.max(0, this.matches.length - 1),
		);
		this.ensureSelectionVisible();
		this.suggestions.visible = !this.compact && this.matches.length > 0;
		this.renderSuggestions();
	}

	private replaceSuggestion(suffix: string) {
		this.input.value = `${this.input.value.slice(0, this.suggestionStart)}${this.matches[this.selectedSuggestion]?.name ?? ""}${suffix}`;
	}

	private highlightSkills(text: string) {
		this.input.clearAllHighlights();
		if (this.skillStyleId === null) return;
		for (const match of text.matchAll(slashCommandPattern())) {
			const prefix = match[1] ?? "";
			const name = `/${match[2] ?? ""}`;
			if (
				!this.commands.some(
					(command) => command.kind === "skill" && command.name === name,
				)
			)
				continue;
			const start = (match.index ?? 0) + prefix.length;
			this.input.addHighlightByCharRange({
				start,
				end: start + name.length,
				styleId: this.skillStyleId,
			});
		}
	}

	private renderSuggestions() {
		const visible = this.matches.slice(
			this.suggestionOffset,
			this.suggestionOffset + SUGGESTION_WINDOW_SIZE,
		);
		this.suggestions.height = visible.length;
		for (const [index, row] of this.suggestionRows.entries()) {
			const command = visible[index];
			row.root.visible = !!command;
			if (!command) continue;
			row.indicator.content =
				index + this.suggestionOffset === this.selectedSuggestion ? "›" : " ";
			row.name.content = command.name;
			row.description.content = command.description;
		}
	}

	private ensureSelectionVisible() {
		if (this.selectedSuggestion < this.suggestionOffset)
			this.suggestionOffset = this.selectedSuggestion;
		if (
			this.selectedSuggestion >=
			this.suggestionOffset + SUGGESTION_WINDOW_SIZE
		)
			this.suggestionOffset =
				this.selectedSuggestion - (SUGGESTION_WINDOW_SIZE - 1);
	}
}
