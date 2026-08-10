import { homedir } from "node:os";
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { TuiState } from "../store";
import { ModelView } from "./model";

export class FooterView {
	readonly root: BoxRenderable;
	private readonly modelLabel: ModelView;
	private readonly pwdLabel: TextRenderable;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "row",
			gap: 2,
		});
    this.modelLabel = new ModelView(renderer);
    this.pwdLabel = new TextRenderable(renderer, {
        content: "",
			fg: "#cdd6f4"
		});
		this.root.add(this.pwdLabel);
		this.root.add(this.modelLabel.box);

	}

	update(state: TuiState) {
		this.modelLabel.update(state);
		this.pwdLabel.content = shortenPath(state.pwd);
	}
}

function shortenPath(path: string) {
	const home = homedir();
	return path === home
		? "~"
		: path.startsWith(`${home}/`)
			? `~${path.slice(home.length)}`
			: path;
}
