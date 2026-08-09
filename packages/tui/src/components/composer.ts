import { BoxRenderable, InputRenderable, InputRenderableEvents, TextRenderable, type CliRenderer, type KeyEvent } from "@opentui/core";

export class ComposerView {
  readonly root: BoxRenderable;
  private readonly input: InputRenderable;

  constructor(
    private readonly renderer: CliRenderer,
    private readonly actions: { submit: (text: string, followUp: boolean) => void; abort: () => void },
  ) {
    this.root = new BoxRenderable(renderer, { width: "100%", height: 3, marginTop: 1, flexDirection: "row", alignItems: "center", border: ["top", "bottom"], borderColor: "#666873", paddingLeft: 1, paddingRight: 1 });
    this.root.add(new TextRenderable(renderer, { content: "›", fg: "#cdd6f4", marginRight: 1 }));
    this.input = new InputRenderable(renderer, { flexGrow: 1, placeholder: "", textColor: "#cdd6f4", backgroundColor: "transparent", focusedBackgroundColor: "transparent" });
    this.input.on(InputRenderableEvents.ENTER, () => this.submit(false));
    this.root.add(this.input);
    renderer.keyInput.prependListener("keypress", this.handleKey);
    this.input.focus();
  }

  get value() { return this.input.value; }

  destroy() { this.renderer.keyInput.off("keypress", this.handleKey); }

  private handleKey = (key: KeyEvent) => {
    if (key.name === "escape") {
      key.preventDefault();
      this.actions.abort();
      return;
    }
    if (key.name === "return" && (key.option || key.meta)) {
      key.preventDefault();
      this.submit(true);
    }
  }

  private submit(followUp: boolean) {
    const text = this.input.value;
    if (!text.trim()) return;
    this.input.value = "";
    this.actions.submit(text, followUp);
  }
}
