import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import { parseModelStatus, type TuiState } from "../store";

export class ModelView {
  readonly box: BoxRenderable;
  private readonly modelNameLabel: TextRenderable
  private readonly modelProviderLabel: TextRenderable

  constructor(renderer: CliRenderer) {
    this.box = new BoxRenderable(renderer, {
      flexDirection: "row",
    });
    this.modelNameLabel = new TextRenderable(renderer, { fg: "#cdd6f4" });
    this.modelProviderLabel = new TextRenderable(renderer, { fg: "#6c7086" });
    this.box.add(this.modelNameLabel);
    this.box.add(this.modelProviderLabel);
  }

  update(state: TuiState) {
    const { status } = state;
    const parsed = parseModelStatus(status);
    if (parsed) {
      const [modelName, modelProvider] = parsed.split("/");
      this.modelNameLabel.content = `${modelName}`;
      this.modelProviderLabel.content = `(${modelProvider})`;
    } else {
      this.modelNameLabel.content = "";
      this.modelProviderLabel.content = "";
    }
  }
}
