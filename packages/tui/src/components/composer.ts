import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	SyntaxStyle,
	TextareaRenderable,
	TextRenderable,
} from "@opentui/core";
import {
	expandsAt,
	type SlashCommandKind,
	slashCommandPattern,
} from "../../../shared/src/slash-command";
import type { FollowUp } from "../store";

const ACCENT = "#89b4fa";
const SUGGESTION_WINDOW_SIZE = 5;
/** How far the composer may grow before the text scrolls inside it instead. */
const MAX_INPUT_ROWS = 10;
const MAX_COMPACT_INPUT_ROWS = 2;
export type CommandHint = {
	name: string;
	description: string;
	kind: SlashCommandKind;
};

/**
 * The textarea reflows on layout, so the wrapped line count is only correct
 * once the new viewport width has landed. Surfacing that moment lets the
 * composer resize itself to the text a terminal resize just rewrapped.
 */
class ComposerInput extends TextareaRenderable {
	onResized: (() => void) | undefined;

	protected override onResize(width: number, height: number) {
		super.onResize(width, height);
		this.onResized?.();
	}
}

export class ComposerView {
	readonly root: BoxRenderable;
	private readonly input: ComposerInput;
	private readonly highlightStyle = SyntaxStyle.fromStyles({
		skill: { fg: ACCENT },
	});
	private readonly highlightStyleId = this.highlightStyle.getStyleId("skill");
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
	private inputRows = 1;
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
			cycleModel: () => void;
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
			/** The prompt marker stays on the first row as the input grows. */
			alignItems: "flex-start",
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
		this.input = new ComposerInput(renderer, {
			flexGrow: 1,
			height: 1,
			placeholder: "",
			textColor: "#a6adc8",
			backgroundColor: "transparent",
			focusedBackgroundColor: "transparent",
			syntaxStyle: this.highlightStyle,
			wrapMode: "word",
			/**
			 * Textarea defaults to Enter inserting a newline; a chat composer wants
			 * the inverse, with Shift+Enter kept for a deliberate line break.
			 */
			keyBindings: [
				{ name: "return", action: "submit" },
				{ name: "kpenter", action: "submit" },
				{ name: "linefeed", action: "submit" },
				{ name: "return", shift: true, action: "newline" },
				{ name: "kpenter", shift: true, action: "newline" },
			],
			onSubmit: () => this.submit(false),
			onContentChange: () => this.syncInput(),
		});
		this.input.onResized = () => this.syncHeight();
		this.inputRow.add(this.input);
		this.root.add(this.queue);
		this.root.add(this.suggestions);
		this.root.add(this.inputRow);
		renderer.keyInput.prependListener("keypress", this.handleKey);
		this.input.focus();
	}

	get value() {
		return this.input.plainText;
	}

	setActive(active: boolean) {
		this.root.visible = active;
		if (active) this.input.focus();
		else this.input.blur();
	}

	setCommands(commands: readonly CommandHint[]) {
		this.commands = commands;
		this.syncInput();
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
		this.root.marginTop = compact ? 0 : 1;
		this.inputRow.border = compact ? ["top"] : ["top", "bottom"];
		this.syncHeight();
		this.syncSuggestions(this.input.plainText);
	}

	private syncInput() {
		const text = this.input.plainText;
		this.highlightCommands(text);
		this.syncSuggestions(text);
		this.syncHeight();
	}

	/**
	 * The textarea has no intrinsic height, so the composer grows to whatever the
	 * word wrap produced, up to the cap past which the textarea scrolls instead.
	 */
	private syncHeight() {
		const wrapped = this.input.editorView.getTotalVirtualLineCount();
		const rows = Math.min(
			Math.max(wrapped, 1),
			this.compact ? MAX_COMPACT_INPUT_ROWS : MAX_INPUT_ROWS,
		);
		const border = this.compact ? 1 : 2;
		if (rows === this.inputRows && this.inputRow.height === rows + border)
			return;
		this.inputRows = rows;
		this.input.height = rows;
		this.inputRow.height = rows + border;
		this.root.minHeight = rows + border;
	}

	private syncQueueVisibility() {
		this.queue.visible = this.hasFollowUps && !this.compact;
	}

	destroy() {
		this.renderer.keyInput.off("keypress", this.handleKey);
		this.highlightStyle.destroy();
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
		if (key.ctrl && key.name === "p") {
			this.actions.cycleModel();
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
				key.preventDefault();
				return;
			}
			/** Shift+Enter is a line break, so it must not accept the suggestion. */
			if (key.name === "return" && !key.shift) {
				this.replaceSuggestion("");
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
		const text = this.input.plainText;
		if (!text.trim()) return;
		this.setValue("");
		this.actions.submit(text, followUp);
	}

	private setValue(text: string) {
		this.input.setText(text);
		this.input.cursorOffset = text.length;
		this.syncInput();
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
		const text = this.input.plainText;
		this.setValue(
			`${text.slice(0, this.suggestionStart)}${this.matches[this.selectedSuggestion]?.name ?? ""}${suffix}`,
		);
	}

	private highlightCommands(text: string) {
		this.input.clearAllHighlights();
		const styleId = this.highlightStyleId;
		if (styleId === null) return;
		for (const match of text.matchAll(slashCommandPattern())) {
			const prefix = match[1] ?? "";
			const name = `/${match[2] ?? ""}`;
			const start = (match.index ?? 0) + prefix.length;
			const command = this.commands.find(
				(candidate) => candidate.name === name,
			);
			if (!expandsAt(command?.kind, start)) continue;
			this.input.addHighlightByCharRange({
				start,
				end: start + name.length,
				styleId,
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
