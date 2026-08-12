import {
	BoxRenderable,
	type CliRenderer,
	InputRenderable,
	InputRenderableEvents,
	type KeyEvent,
	type SelectOption,
	SelectRenderable,
	SelectRenderableEvents,
	TextRenderable,
} from "@opentui/core";

const ACCENT = "#89b4fa";

export type WizardScreen =
	| {
			kind: "select";
			title: string;
			options: SelectOption[];
			searchable?: boolean;
			descriptionLayout?: "inline" | "two-line";
	  }
	| {
			kind: "multiselect";
			title: string;
			options: SelectOption[];
			/** Option values that start out checked. */
			selected: string[];
			searchable?: boolean;
	  }
	| {
			kind: "input";
			title: string;
			placeholder?: string;
			secret?: boolean;
			url?: string;
	  }
	| { kind: "notice"; title: string; text: string };

type WizardActions = {
	select?: (option: SelectOption) => void;
	confirm?: (values: string[]) => void;
	submit?: (value: string) => void;
	open?: () => void;
	cancel: () => void;
};

/** A local-only shell for catalog and authentication interactions. */
export class WizardView {
	readonly root: BoxRenderable;
	private readonly title: TextRenderable;
	private readonly message: TextRenderable;
	private readonly inputRow: BoxRenderable;
	private readonly input: InputRenderable;
	private readonly secretMask: TextRenderable;
	private readonly select: SelectRenderable;
	private readonly inlineSelect: BoxRenderable;
	private readonly inlineRows: {
		root: BoxRenderable;
		indicator: TextRenderable;
		name: TextRenderable;
		description: TextRenderable;
	}[];
	private readonly footer: TextRenderable;
	private screen: WizardScreen | undefined;
	private actions: WizardActions | undefined;
	private allOptions: SelectOption[] = [];
	private inlineOptions: SelectOption[] = [];
	private inlineSelected = 0;
	private checked = new Set<string>();

	constructor(private readonly renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			minHeight: 6,
			maxHeight: "70%",
			flexDirection: "column",
			border: ["top", "bottom"],
			borderColor: ACCENT,
			padding: 1,
			visible: false,
		});
		this.title = new TextRenderable(renderer, {
			fg: "#89dceb",
			marginBottom: 1,
		});
		this.message = new TextRenderable(renderer, {
			fg: "#cdd6f4",
			marginBottom: 1,
			visible: false,
		});
		this.inputRow = new BoxRenderable(renderer, {
			width: "100%",
			height: 1,
			marginBottom: 1,
			position: "relative",
			visible: false,
		});
		this.input = new InputRenderable(renderer, {
			width: "100%",
			placeholder: "",
			textColor: "#cdd6f4",
			focusedTextColor: "#cdd6f4",
			backgroundColor: "transparent",
			focusedBackgroundColor: "transparent",
		});
		this.secretMask = new TextRenderable(renderer, {
			position: "absolute",
			left: 0,
			top: 0,
			zIndex: 1,
			fg: "#cdd6f4",
			visible: false,
		});
		this.inputRow.add(this.input);
		this.inputRow.add(this.secretMask);
		this.select = new SelectRenderable(renderer, {
			width: "100%",
			height: 5,
			backgroundColor: "transparent",
			focusedBackgroundColor: "transparent",
			selectedBackgroundColor: "transparent",
			textColor: "#cdd6f4",
			focusedTextColor: "#cdd6f4",
			selectedTextColor: "#89dceb",
			descriptionColor: "#6c7086",
			selectedDescriptionColor: ACCENT,
			showScrollIndicator: true,
			visible: false,
		});
		this.inlineSelect = new BoxRenderable(renderer, {
			width: "100%",
			height: 5,
			flexDirection: "column",
			visible: false,
		});
		this.inlineRows = Array.from({ length: 5 }, () => {
			const root = new BoxRenderable(renderer, {
				width: "100%",
				height: 1,
				flexDirection: "row",
				visible: false,
			});
			const indicator = new TextRenderable(renderer, { width: 2 });
			const name = new TextRenderable(renderer, {});
			const description = new TextRenderable(renderer, {});
			root.add(indicator);
			root.add(name);
			root.add(description);
			this.inlineSelect.add(root);
			return { root, indicator, name, description };
		});
		this.footer = new TextRenderable(renderer, {
			content: "↑↓ navigate  ·  Enter select  ·  Esc cancel",
			fg: "#6c7086",
			marginTop: 1,
		});
		this.root.add(this.title);
		this.root.add(this.message);
		this.root.add(this.inputRow);
		this.root.add(this.select);
		this.root.add(this.inlineSelect);
		this.root.add(this.footer);
		this.input.on(InputRenderableEvents.INPUT, () => this.updateInput());
		this.input.on(InputRenderableEvents.ENTER, () => {
			if (this.screen?.kind === "select") this.select.selectCurrent();
			else if (this.screen?.kind === "input")
				this.actions?.submit?.(this.input.value);
		});
		this.select.on(
			SelectRenderableEvents.ITEM_SELECTED,
			(_index: number, option: SelectOption) => this.actions?.select?.(option),
		);
		renderer.keyInput.prependListener("keypress", this.handleKey);
	}

	show(screen: WizardScreen, actions: WizardActions) {
		this.screen = screen;
		this.actions = actions;
		this.root.visible = true;
		this.title.content = screen.title;
		this.message.visible =
			screen.kind === "notice" || (screen.kind === "input" && !!screen.url);
		this.message.content =
			screen.kind === "notice"
				? screen.text
				: screen.kind === "input"
					? (screen.url ?? "")
					: "";
		const searchable =
			(screen.kind === "select" || screen.kind === "multiselect") &&
			!!screen.searchable;
		this.inputRow.visible = screen.kind === "input" || searchable;
		const inlineDescriptions =
			screen.kind === "multiselect" ||
			(screen.kind === "select" && screen.descriptionLayout === "inline");
		this.select.visible = screen.kind === "select" && !inlineDescriptions;
		this.inlineSelect.visible = inlineDescriptions;
		this.select.showDescription = !inlineDescriptions;
		this.footer.content =
			screen.kind === "notice"
				? actions.open
					? "Ctrl+O open browser  ·  Esc close"
					: "Esc close"
				: screen.kind === "input"
					? actions.open
						? "Enter submit  ·  Ctrl+O open browser  ·  Esc cancel"
						: "Enter submit  ·  Esc cancel"
					: screen.kind === "multiselect"
						? "↑↓ navigate  ·  Space toggle  ·  Enter save  ·  Esc cancel"
						: "↑↓ navigate  ·  Enter select  ·  Esc cancel";
		this.input.value = "";
		this.secretMask.content = "";
		this.secretMask.visible = screen.kind === "input" && !!screen.secret;
		this.input.opacity = screen.kind === "input" && screen.secret ? 0 : 1;
		this.input.placeholder =
			screen.kind === "input"
				? (screen.placeholder ?? "")
				: searchable
					? "Type to filter"
					: "";
		this.allOptions =
			screen.kind === "select" || screen.kind === "multiselect"
				? screen.options
				: [];
		this.checked =
			screen.kind === "multiselect" ? new Set(screen.selected) : new Set();
		this.select.options = this.allOptions;
		this.select.selectedIndex = 0;
		this.inlineOptions = this.allOptions;
		this.inlineSelected = 0;
		this.renderInlineOptions();
		if (screen.kind === "input" || searchable) this.input.focus();
		else if (screen.kind === "select" && !inlineDescriptions)
			this.select.focus();
	}

	hide() {
		this.root.visible = false;
		this.input.blur();
		this.screen = undefined;
		this.actions = undefined;
	}

	destroy() {
		this.renderer.keyInput.off("keypress", this.handleKey);
	}

	private updateInput() {
		if (this.screen?.kind === "input" && this.screen.secret) {
			this.secretMask.content = "•".repeat(this.input.value.length);
			return;
		}
		if (
			(this.screen?.kind !== "select" && this.screen?.kind !== "multiselect") ||
			!this.screen.searchable
		)
			return;
		const query = this.input.value.toLowerCase();
		const options = this.allOptions.filter(({ name, description }) =>
			`${name} ${description}`.toLowerCase().includes(query),
		);
		if (
			this.screen.kind === "multiselect" ||
			this.screen.descriptionLayout === "inline"
		) {
			this.inlineOptions = options;
			this.inlineSelected = 0;
			this.renderInlineOptions();
		} else {
			this.select.options = options;
			this.select.selectedIndex = 0;
		}
	}

	private handleKey = (key: KeyEvent) => {
		if (!this.root.visible || key.defaultPrevented) return;
		if (key.name === "escape") {
			key.preventDefault();
			key.stopPropagation();
			this.actions?.cancel();
			return;
		}
		if (key.name === "o" && key.ctrl && this.actions?.open) {
			key.preventDefault();
			key.stopPropagation();
			this.actions.open();
			return;
		}
		if (this.screen?.kind === "multiselect") {
			if (key.name === "up") this.inlineSelected--;
			else if (key.name === "down") this.inlineSelected++;
			else if (key.name === "space") {
				this.toggleChecked();
				key.preventDefault();
				return;
			} else if (key.name === "return") {
				key.preventDefault();
				this.actions?.confirm?.(
					this.allOptions
						.map((option) => String(option.value))
						.filter((value) => this.checked.has(value)),
				);
				return;
			} else return;
			this.moveInline();
			key.preventDefault();
			return;
		}
		if (
			this.screen?.kind === "select" &&
			this.screen.descriptionLayout === "inline"
		) {
			if (key.name === "up") this.inlineSelected--;
			else if (key.name === "down") this.inlineSelected++;
			else if (key.name === "return") {
				const option = this.inlineOptions[this.inlineSelected];
				if (option) this.actions?.select?.(option);
				key.preventDefault();
				return;
			} else return;
			this.moveInline();
			key.preventDefault();
			return;
		}
		if (this.screen?.kind === "select" && this.screen.searchable) {
			if (key.name === "up") {
				this.select.moveUp();
				key.preventDefault();
				return;
			}
			if (key.name === "down") {
				this.select.moveDown();
				key.preventDefault();
				return;
			}
		}
	};

	private moveInline() {
		this.inlineSelected = Math.max(
			0,
			Math.min(this.inlineSelected, this.inlineOptions.length - 1),
		);
		this.renderInlineOptions();
	}

	private toggleChecked() {
		const value = this.inlineOptions[this.inlineSelected]?.value;
		if (value === undefined) return;
		const key = String(value);
		if (!this.checked.delete(key)) this.checked.add(key);
		this.renderInlineOptions();
	}

	private renderInlineOptions() {
		const start = Math.max(
			0,
			Math.min(
				this.inlineSelected - Math.floor(this.inlineRows.length / 2),
				this.inlineOptions.length - this.inlineRows.length,
			),
		);
		for (const [index, row] of this.inlineRows.entries()) {
			const option = this.inlineOptions[start + index];
			const selected = start + index === this.inlineSelected;
			row.root.visible = !!option;
			if (!option) continue;
			row.indicator.content = selected ? "▶ " : "  ";
			row.indicator.fg = selected ? "#89dceb" : "#cdd6f4";
			row.name.content =
				this.screen?.kind === "multiselect"
					? `${this.checked.has(String(option.value)) ? "[x]" : "[ ]"} ${option.name}`
					: option.name;
			row.name.fg = selected ? "#89dceb" : "#cdd6f4";
			row.description.content = option.description
				? ` · ${option.description}`
				: "";
			row.description.fg = selected ? ACCENT : "#6c7086";
		}
	}
}
