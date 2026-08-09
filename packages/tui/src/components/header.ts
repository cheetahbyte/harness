import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { TuiState } from "../store";

export class HeaderView {
	readonly root: BoxRenderable;
	private readonly label: TextRenderable;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "row",
			justifyContent: "space-between",
			marginBottom: 1,
		});
		this.label = new TextRenderable(renderer, { fg: "#cdd6f4" });
		this.root.add(this.label);
	}

	update(state: TuiState) {
		this.label.content = `Harness  ${state.sessionId}    ${state.running ? "running" : "idle"}`;
	}
}
