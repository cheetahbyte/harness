import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";
import { parseModelStatus, type TuiState } from "../store";

export class HeaderView {
  readonly root: BoxRenderable;
  private readonly label: TextRenderable;

  constructor(renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, { width: "100%", flexDirection: "row", justifyContent: "space-between", marginBottom: 1 });
    this.label = new TextRenderable(renderer, { fg: "#cdd6f4" });
    this.root.add(this.label);
  }

  update(state: TuiState) {
    const model = parseModelStatus(state.configuredStatus) ?? "no model";
    this.label.content = `Harness  ${state.sessionId}    ${state.running ? "running" : "idle"}  ${model}`;
  }
}
