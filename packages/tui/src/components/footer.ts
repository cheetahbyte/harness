import {
	BoxRenderable,
	type CliRenderer,
	fg,
	StyledText,
	type TextChunk,
	TextRenderable,
} from "@opentui/core";

import { formatUsd, type TuiState } from "../store";
import { ModelView } from "./model";
import { DIM, TEXT } from "./theme";

/** Blank columns the row's gap puts between model and metrics. */
const SEGMENT_GAP = 2;
export class FooterView {
	readonly root: BoxRenderable;
	private readonly modelLabel: ModelView;
	private readonly costLabel: TextRenderable;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "row",
			gap: 2,
		});
		this.modelLabel = new ModelView(renderer);
		this.costLabel = new TextRenderable(renderer, {
			content: "",
			visible: false,
		});
		this.root.add(this.modelLabel.box);
		this.root.add(this.costLabel);
	}

	update(state: TuiState) {
		this.modelLabel.update(state);
		this.fitCost(state);
	}

	/**
	 * The row does not clip, so an oversized readout would overprint the model
	 * label rather than shrink. Cost is ambient information, so hide it when it
	 * does not fit.
	 */
	private fitCost(state: TuiState) {
		const variants = costVariants(state);
		/**
		 * Measured against the terminal rather than the row's own width, which is
		 * still the pre-resize value while this runs. `x` is the app's padding, and
		 * the row is inset by the same amount on the right.
		 */
		const available =
			this.root.ctx.width -
			2 * this.root.x -
			this.modelLabel.width -
			SEGMENT_GAP;
		const fitting = variants.find((variant) => width(variant) <= available);
		this.costLabel.visible = fitting !== undefined;
		if (fitting) this.costLabel.content = new StyledText(fitting);
	}
}

function costVariants(state: TuiState): TextChunk[][] {
	const cost =
		state.sessionCostUsd === undefined
			? []
			: [fg(DIM)("Σ "), fg(TEXT)(formatUsd(state.sessionCostUsd))];
	return cost.length ? [cost] : [];
}

function width(chunks: TextChunk[]) {
	return chunks.reduce((total, chunk) => total + chunk.text.length, 0);
}
