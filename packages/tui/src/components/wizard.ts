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

export type WizardScreen =
	| {
			kind: "select";
			title: string;
			options: SelectOption[];
			searchable?: boolean;
			inlineDescriptions?: boolean;
	  }
	| { kind: "input"; title: string; placeholder?: string; secret?: boolean }
	| { kind: "notice"; title: string; text: string };

type WizardActions = {
	select?: (option: SelectOption) => void;
	submit?: (value: string) => void;
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
	private readonly footer: TextRenderable;
	private screen: WizardScreen | undefined;
	private actions: WizardActions | undefined;
	private allOptions: SelectOption[] = [];

	constructor(private readonly renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			minHeight: 6,
			maxHeight: "70%",
			flexDirection: "column",
			border: ["top", "bottom"],
			borderColor: "#89b4fa",
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
			selectedDescriptionColor: "#89b4fa",
			showScrollIndicator: true,
			visible: false,
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
		this.message.visible = screen.kind === "notice";
		this.message.content = screen.kind === "notice" ? screen.text : "";
		this.inputRow.visible =
			screen.kind === "input" ||
			(screen.kind === "select" && !!screen.searchable);
		this.select.visible = screen.kind === "select";
		this.select.showDescription =
			screen.kind !== "select" || !screen.inlineDescriptions;
		this.footer.content =
			screen.kind === "notice"
				? "Esc close"
				: screen.kind === "input"
					? "Enter submit  ·  Esc cancel"
					: "↑↓ navigate  ·  Enter select  ·  Esc cancel";
		this.input.value = "";
		this.secretMask.content = "";
		this.secretMask.visible = screen.kind === "input" && !!screen.secret;
		this.input.opacity = screen.kind === "input" && screen.secret ? 0 : 1;
		this.input.placeholder =
			screen.kind === "input"
				? (screen.placeholder ?? "")
				: screen.kind === "select" && screen.searchable
					? "Type to filter"
					: "";
		this.allOptions = screen.kind === "select" ? screen.options : [];
		this.select.options = this.allOptions;
		this.select.selectedIndex = 0;
		if (
			screen.kind === "input" ||
			(screen.kind === "select" && screen.searchable)
		)
			this.input.focus();
		else if (screen.kind === "select") this.select.focus();
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
		if (this.screen?.kind !== "select" || !this.screen.searchable) return;
		const query = this.input.value.toLowerCase();
		this.select.options = this.allOptions.filter(({ name, description }) =>
			`${name} ${description}`.toLowerCase().includes(query),
		);
		this.select.selectedIndex = 0;
	}

	private handleKey = (key: KeyEvent) => {
		if (!this.root.visible || key.defaultPrevented) return;
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
		if (key.name === "escape") {
			key.preventDefault();
			key.stopPropagation();
			this.actions?.cancel();
		}
	};
}
