import { BoxRenderable, TextRenderable, type CliRenderer } from "@opentui/core";

export class FooterView {
  readonly root: BoxRenderable;

  constructor(renderer: CliRenderer) {
    this.root = new BoxRenderable(renderer, { width: "100%", flexDirection: "row" });
    this.root.add(new TextRenderable(renderer, { content: "▶▶", fg: "#cba6f7", marginRight: 1 }));
    this.root.add(new TextRenderable(renderer, { content: "Enter steer  ·  Option+Enter follow-up  ·  Esc abort", fg: "#8b8d98" }));
  }
}
