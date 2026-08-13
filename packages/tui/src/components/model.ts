import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { TuiState } from "../store";
import { DIM, TEXT } from "./theme";

export class ModelView {
	readonly box: BoxRenderable;
	private readonly modelNameLabel: TextRenderable;
	private readonly modelProviderLabel: TextRenderable;
	private renderedWidth = 0;

	constructor(renderer: CliRenderer) {
		this.box = new BoxRenderable(renderer, {
			flexDirection: "row",
		});
		this.modelNameLabel = new TextRenderable(renderer, { fg: TEXT });
		this.modelProviderLabel = new TextRenderable(renderer, { fg: DIM });
		this.box.add(this.modelNameLabel);
		this.box.add(this.modelProviderLabel);
	}

	/** Rendered columns, so neighbours in a row can budget around this label. */
	get width() {
		return this.renderedWidth;
	}

	update(state: TuiState) {
		const { modelConfig } = state;
		const name = modelConfig?.model ?? "";
		const provider = modelConfig
			? ` (${modelConfig.provider})${modelConfig.thinkingLevel ? ` · ${modelConfig.thinkingLevel}` : ""}`
			: "";
		this.modelNameLabel.content = name;
		this.modelProviderLabel.content = provider;
		this.renderedWidth = name.length + provider.length;
	}
}
