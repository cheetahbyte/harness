import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { parseModelStatus, type TuiState } from "../store";

export class FooterView {
	readonly root: BoxRenderable;
	private readonly label: TextRenderable;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "row",
		});
		this.label = new TextRenderable(renderer, { fg: "#cdd6f4" });
		this.root.add(this.label);
	}

	update(state: TuiState) {
		const model = parseModelStatus(state.configuredStatus) ?? "no model";
		this.label.content = `${model}`;
	}
}
