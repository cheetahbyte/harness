import { BoxRenderable, type CliRenderer } from "@opentui/core";
import type { StoreApi } from "zustand/vanilla";
import type { ClientCommand } from "../../shared/src/protocol";
import { ComposerView } from "./components/composer";
import { FooterView } from "./components/footer";
import { HeaderView } from "./components/header";
import { TranscriptView } from "./components/transcript";
import { commandForInput, type TuiState } from "./store";

export class TuiApp {
  private readonly header: HeaderView;
  private readonly transcript: TranscriptView;
  private readonly composer: ComposerView;
  private readonly unsubscribe: () => void;

  constructor(
    renderer: CliRenderer,
    private readonly store: StoreApi<TuiState>,
    private readonly send: (command: ClientCommand) => Promise<void>,
  ) {
    const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column", padding: 1, paddingBottom: 0 });
    this.header = new HeaderView(renderer);
    this.transcript = new TranscriptView(renderer);
    this.composer = new ComposerView(renderer, { submit: (text, followUp) => void this.submit(text, followUp), abort: () => void this.send({ type: "abort" }) });
    const footer = new FooterView(renderer);
    root.add(this.header.root);
    root.add(this.transcript.root);
    root.add(this.composer.root);
    root.add(footer.root);
    renderer.root.add(root);
    this.unsubscribe = store.subscribe(() => this.sync());
    this.sync();
  }

  destroy() {
    this.unsubscribe();
    this.composer.destroy();
  }

  private async submit(text: string, followUp: boolean) {
    const command = followUp ? { type: "follow-up" as const, text } : commandForInput(text);
    if (command.type === "steer" || command.type === "follow-up") this.store.getState().addUser(text);
    try {
      await this.send(command);
    } catch (error) {
      this.store.getState().apply({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private sync() {
    const state = this.store.getState();
    this.header.update(state);
    this.transcript.update(state.entries);
  }
}
