import { BoxRenderable, type CliRenderer} from "@opentui/core";
import type { TuiState } from "../store";
import { ModelView } from "./model";

export class FooterView {
  readonly root: BoxRenderable;
  private readonly modelLabel: ModelView;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "row",
		});
		this.modelLabel = new ModelView(renderer);
		this.root.add(this.modelLabel);
	}

	update(state: TuiState) {
		this.modelLabel.update(state);
	}
}
