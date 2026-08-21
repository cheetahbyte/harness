import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	SyntaxStyle,
	TextareaRenderable,
	TextRenderable,
	type HostClipboardService,
} from "@opentui/core";

import type {
	ImageAttachment,
	SubagentStateEvent,
} from "../../../shared/src/protocol";
import {
	expandsAt,
	type SlashCommandKind,
	slashCommandPattern,
} from "../../../shared/src/slash-command";
import type { FollowUp } from "../store";
import { ACCENT, DIM, TEXT, thinkingColor } from "./theme";

const SUGGESTION_WINDOW_SIZE = 5;
/** How far the composer may grow before the text scrolls inside it instead. */
const MAX_INPUT_ROWS = 10;
const MAX_COMPACT_INPUT_ROWS = 2;
const RUNNING_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"] as const;
const RUNNING_PHRASES = [
	"doing the minimum, professionally",
	"asking the type checker to look away",
	"walking the bug until it confesses",
	"checking whether production noticed",
	"box, box — the tests are cooked",
] as const;
const RUNNING_FRAME_MS = 120;
function isImageMime(
	value: string | undefined,
): value is ImageAttachment["mimeType"] {
	return (
		value === "image/png" ||
		value === "image/jpeg" ||
		value === "image/gif" ||
		value === "image/webp"
	);
}
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
	private readonly runningIndicator: TextRenderable;
	private readonly suggestions: BoxRenderable;
	private readonly suggestionRows: {
		root: BoxRenderable;
		indicator: TextRenderable;
		name: TextRenderable;
		description: TextRenderable;
	}[];
	private readonly inputRow: BoxRenderable;
	private readonly activeAgents: BoxRenderable;
	private readonly activeAgentRows: {
		root: BoxRenderable;
		indicator: TextRenderable;
		text: TextRenderable;
	}[];
	private commands: readonly CommandHint[];
	private hasFollowUps = false;
	private compact = false;
	private inputRows = 1;
	private running = false;
	private runningFrame = 0;
	private runningPhrase = -1;
	private runningAnimation: ReturnType<typeof setInterval> | undefined;
	private matches: CommandHint[] = [];
	private selectedSuggestion = 0;
	private suggestionOffset = 0;
	private suggestionStart = 0;
	private activeAgentList: SubagentStateEvent["agent"][] = [];
	private activeAgentSelection = 0;
	private images: ImageAttachment[] = [];

	constructor(
		private readonly renderer: CliRenderer,
		commands: readonly CommandHint[],
		private readonly actions: {
			submit: (
				text: string,
				images: ImageAttachment[],
				followUp: boolean,
			) => Promise<void>;
			abort: () => void;
			toggleThinking: () => void;
			cycleThinkingLevel: () => void;
			cycleModel: () => void;
			openAgent?: (id: string | undefined) => void;
		},
		private readonly clipboard?: HostClipboardService,
	) {
		this.commands = commands;
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			minHeight: 3,
			marginTop: 1,
			flexDirection: "column",
		});
		this.queue = new TextRenderable(renderer, {
			fg: DIM,
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
				fg: DIM,
			});
			const name = new TextRenderable(renderer, {
				fg: ACCENT,
				flexShrink: 0,
				marginRight: 2,
			});
			const description = new TextRenderable(renderer, {
				flexGrow: 1,
				fg: DIM,
				truncate: true,
			});
			root.add(indicator);
			root.add(name);
			root.add(description);
			this.suggestions.add(root);
			return { root, indicator, name, description };
		});
		this.runningIndicator = new TextRenderable(renderer, {
			content: RUNNING_FRAMES[0],
			fg: ACCENT,
			visible: false,
		});
		this.inputRow = new BoxRenderable(renderer, {
			width: "100%",
			height: 3,
			flexDirection: "row",
			/** The prompt marker stays on the first row as the input grows. */
			alignItems: "flex-start",
			border: ["top", "bottom"],
			borderColor: DIM,
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
			cursorStyle: { style: "line", blinking: true },
			textColor: TEXT,
			focusedTextColor: TEXT,
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
		this.activeAgents = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "column",
			marginTop: 1,
			visible: false,
		});
		this.activeAgentRows = Array.from({ length: 10 }, () => {
			const root = new BoxRenderable(renderer, {
				width: "100%",
				height: 1,
				flexDirection: "row",
				visible: false,
			});
			const indicator = new TextRenderable(renderer, { width: 2, fg: ACCENT });
			const text = new TextRenderable(renderer, {
				fg: DIM,
				truncate: true,
				flexGrow: 1,
			});
			root.add(indicator);
			root.add(text);
			this.activeAgents.add(root);
			return { root, indicator, text };
		});
		this.root.add(this.queue);
		this.root.add(this.suggestions);
		this.root.add(this.runningIndicator);
		this.root.add(this.inputRow);
		this.root.add(this.activeAgents);
		renderer.keyInput.prependListener("keypress", this.handleKey);
		renderer.keyInput.prependListener("paste", this.handlePaste);
		this.input.focus();
	}

	get value() {
		return this.input.plainText;
	}

	get attachments() {
		return structuredClone(this.images);
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

	setActiveAgents(agents: readonly SubagentStateEvent["agent"][]) {
		this.activeAgentList = agents.filter((agent) =>
			["queued", "running", "cancelling"].includes(agent.state),
		);
		this.activeAgentSelection = Math.min(
			this.activeAgentSelection,
			Math.max(0, this.activeAgentList.length - 1),
		);
		this.renderActiveAgents();
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

	setThinkingLevel(level?: Parameters<typeof thinkingColor>[0]) {
		this.inputRow.borderColor = thinkingColor(level);
	}

	setRunning(running: boolean) {
		if (running === this.running) return;
		this.running = running;
		this.runningIndicator.visible = running;
		if (running) {
			this.runningFrame = 0;
			this.runningPhrase = (this.runningPhrase + 1) % RUNNING_PHRASES.length;
			this.runningIndicator.content = this.runningContent();
			this.runningAnimation = setInterval(
				this.advanceRunning,
				RUNNING_FRAME_MS,
			);
		} else if (this.runningAnimation) {
			clearInterval(this.runningAnimation);
			this.runningAnimation = undefined;
		}
		this.syncHeight();
		this.renderer.requestRender();
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
		const chrome = this.compact ? 1 : 2;
		const minHeight = rows + chrome + Number(this.running);
		this.root.minHeight = minHeight;
		if (rows === this.inputRows && this.inputRow.height === rows + chrome)
			return;
		this.inputRows = rows;
		this.input.height = rows;
		this.inputRow.height = rows + chrome;
	}

	private syncQueueVisibility() {
		this.queue.visible = this.hasFollowUps && !this.compact;
	}

	destroy() {
		if (this.runningAnimation) clearInterval(this.runningAnimation);
		this.renderer.keyInput.off("keypress", this.handleKey);
		this.renderer.keyInput.off("paste", this.handlePaste);
		this.highlightStyle.destroy();
	}

	private advanceRunning = () => {
		this.runningFrame = (this.runningFrame + 1) % RUNNING_FRAMES.length;
		this.runningIndicator.content = this.runningContent();
		this.renderer.requestRender();
	};

	private runningContent() {
		return `${RUNNING_FRAMES[this.runningFrame]} ${RUNNING_PHRASES[this.runningPhrase]}`;
	}

	private handleKey = (key: KeyEvent) => {
		if (key.defaultPrevented) return;
		if ((key.ctrl || key.meta) && key.name === "v") {
			key.preventDefault();
			void this.readClipboard();
			return;
		}
		if (this.root.visible && !this.input.focused) this.input.focus();
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
		if (
			this.activeAgents.visible &&
			(key.name === "up" || key.name === "down")
		) {
			if (key.name === "up" && this.activeAgentSelection === 0) {
				this.activeAgents.visible = false;
				key.preventDefault();
				return;
			}
			const direction = key.name === "up" ? -1 : 1;
			this.activeAgentSelection = Math.max(
				0,
				Math.min(
					this.activeAgentList.length - 1,
					this.activeAgentSelection + direction,
				),
			);
			this.renderActiveAgents();
			key.preventDefault();
			return;
		}
		if (
			!this.suggestions.visible &&
			key.name === "down" &&
			this.activeAgentList.length
		) {
			this.activeAgents.visible = true;
			this.activeAgentSelection = 0;
			this.renderActiveAgents();
			key.preventDefault();
			return;
		}
		if (this.activeAgents.visible && key.name === "return") {
			this.actions.openAgent?.(
				this.activeAgentList[this.activeAgentSelection]?.id,
			);
			key.preventDefault();
			return;
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

	private handlePaste = (event: {
		bytes: Uint8Array;
		metadata?: { kind?: string; mimeType?: string };
		preventDefault: () => void;
	}) => {
		const mimeType = event.metadata?.mimeType;
		if (event.metadata?.kind !== "binary" || !isImageMime(mimeType)) return;
		event.preventDefault();
		this.attachImage(mimeType, event.bytes);
	};

	private async readClipboard() {
		if (!this.clipboard) return;
		try {
			const result = await this.clipboard.read({
				preferredTypes: [
					"image/png",
					"image/jpeg",
					"image/webp",
					"image/gif",
					"text/plain",
				],
			});
			if (result.status !== "read") return;
			if (isImageMime(result.representation.mimeType))
				this.attachImage(
					result.representation.mimeType,
					result.representation.bytes,
				);
			else if (result.representation.mimeType === "text/plain")
				this.input.insertText(
					new TextDecoder().decode(result.representation.bytes),
				);
		} catch {
			// Clipboard availability is platform-dependent.
		}
	}

	private attachImage(
		mimeType: ImageAttachment["mimeType"],
		bytes: Uint8Array,
	) {
		if (this.images.length >= 4) return;
		this.images.push({
			id: crypto.randomUUID(),
			mimeType,
			data: Buffer.from(bytes).toString("base64"),
		});
		this.input.insertText(`[Image #${this.images.length}]`);
		this.syncInput();
	}

	private async submit(followUp: boolean) {
		const text = this.input.plainText.replace(/\[Image #\d+\]/g, "").trim();
		if (!text.trim() && !this.images.length) return;
		const snapshot = { text: this.input.plainText, images: this.attachments };
		this.setValue("");
		this.images = [];
		try {
			await this.actions.submit(text, snapshot.images, followUp);
		} catch (error) {
			this.images = snapshot.images;
			this.setValue(snapshot.text);
			throw error;
		}
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

	private renderActiveAgents() {
		this.activeAgents.height = this.activeAgents.visible
			? this.activeAgentList.length
			: 0;
		for (const [index, row] of this.activeAgentRows.entries()) {
			const agent = this.activeAgentList[index];
			row.root.visible = this.activeAgents.visible && !!agent;
			if (!agent) continue;
			row.indicator.content = index === this.activeAgentSelection ? "›" : " ";
			row.text.content = `• ${agent.profile} · ${agent.description} [${agent.state}]`;
		}
		this.syncHeight();
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
