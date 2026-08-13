import {
	BoxRenderable,
	type CliRenderer,
	fg,
	StyledText,
	type TextChunk,
	TextRenderable,
} from "@opentui/core";
import { formatTokens, formatUsd, type TuiState } from "../store";
import { ModelView } from "./model";
import { DIM, TEXT } from "./theme";

/** Blank columns the row's gap puts between model and metrics. */
const SEGMENT_GAP = 2;
export class FooterView {
	readonly root: BoxRenderable;
	private readonly modelLabel: ModelView;
	private readonly leverageLabel: TextRenderable;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "row",
			gap: 2,
		});
		this.modelLabel = new ModelView(renderer);
		/**
		 * Hidden rather than blanked when there is nothing to say: an empty
		 * renderable still claims the row's `gap`, which would leave the path and
		 * the model drifting apart for sessions that never compact.
		 */
		this.leverageLabel = new TextRenderable(renderer, {
			content: "",
			visible: false,
		});
		this.root.add(this.modelLabel.box);
		this.root.add(this.leverageLabel);
	}

	update(state: TuiState) {
		this.modelLabel.update(state);
		this.fitLeverage(state);
	}

	/**
	 * The row does not clip, so an oversized readout would overprint the model
	 * label rather than shrink. Falls back to the bare ratio and then to nothing,
	 * since the leverage figure is ambient information — never worth corrupting
	 * the working directory or the active model to keep.
	 */
	private fitLeverage(state: TuiState) {
		const variants = leverageVariants(state);
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
		this.leverageLabel.visible = fitting !== undefined;
		if (fitting) this.leverageLabel.content = new StyledText(fitting);
	}
}

/**
 * Widest form first. Reads as "this session commands 120k of history for 26k of
 * prompt", the one figure that rises as a session gets more valuable instead of
 * counting down toward a limit.
 */
function leverageVariants(state: TuiState): TextChunk[][] {
	const status = state.contextStatus;
	const cost =
		state.sessionCostUsd === undefined
			? []
			: [fg(DIM)("Σ "), fg(TEXT)(formatUsd(state.sessionCostUsd))];
	if (!status || status.historyTokens <= status.liveTokens)
		return cost.length ? [cost] : [];
	const ratio = [
		fg(DIM)("≡ "),
		fg(TEXT)(formatTokens(status.historyTokens)),
		fg(DIM)(" ↦ "),
		fg(TEXT)(formatTokens(status.liveTokens)),
	];
	const combined = cost.length ? [...ratio, fg(DIM)(" · "), ...cost] : ratio;
	if (!status.parkedObservations)
		return cost.length ? [combined, cost, ratio] : [ratio];
	return [
		[
			...ratio,
			fg(DIM)(` · ${status.parkedObservations} recallable`),
			...(cost.length ? [fg(DIM)(" · "), ...cost] : []),
		],
		combined,
		...(cost.length ? [cost] : []),
		ratio,
	];
}

function width(chunks: TextChunk[]) {
	return chunks.reduce((total, chunk) => total + chunk.text.length, 0);
}
