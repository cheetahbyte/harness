import {
	BoxRenderable,
	type CliRenderer,
	fg,
	StyledText,
	type TextChunk,
	TextRenderable,
} from "@opentui/core";

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
		const provider = modelConfig ? ` (${modelConfig.provider})` : "";
		/**
		 * The provider is where the model came from, but the thinking level is a
		 * setting the session is running under, so it reads as brightly as the
		 * model name it applies to.
		 */
		const level = modelConfig?.thinkingLevel ?? "";
		const chunks: TextChunk[] = [];
		if (provider) chunks.push(fg(DIM)(provider));
		if (level) chunks.push(fg(DIM)(" · "), fg(TEXT)(level));
		this.modelNameLabel.content = name;
		this.modelProviderLabel.content = chunks.length
			? new StyledText(chunks)
			: "";
		this.renderedWidth =
			name.length + provider.length + (level ? level.length + 3 : 0);
	}
}
