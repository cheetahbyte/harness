import { homedir } from "node:os";
import {
	BoxRenderable,
	bold,
	type CliRenderer,
	fg,
	StyledText,
	TextRenderable,
	t,
} from "@opentui/core";
import { VERSION } from "../../../shared/src/version";
import type { TuiState } from "../store";
import { ACCENT, DIM, TEXT, WARNING } from "./theme";

export class HeaderView {
	readonly root: BoxRenderable;
	private readonly details: TextRenderable;
	private state: TuiState | undefined;
	private noticeText: { full: string; short: string } | undefined;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "row",
			marginBottom: 1,
		});
		const identity = new BoxRenderable(renderer, {
			flexDirection: "row",
			alignItems: "center",
			gap: 2,
		});
		identity.add(
			new TextRenderable(renderer, {
				content: "╲ ╱\n ◆ \n╱ ╲",
				fg: ACCENT,
			}),
		);
		this.details = new TextRenderable(renderer, {});
		identity.add(this.details);
		this.root.add(identity);
	}

	setNotice(text: { full: string; short: string }) {
		this.noticeText = text;
		if (this.state) this.render(this.state);
	}

	update(state: TuiState) {
		this.state = state;
		this.render(state);
	}

	private render(state: TuiState) {
		const model = state.modelConfig
			? `${state.modelConfig.model} · ${state.modelConfig.provider}`
			: "No model selected";
		const status = state.running ? "running" : "idle";
		const path = shortenPath(state.pwd);
		const notice = this.fittingNotice();
		this.details.content = new StyledText(
			t`${bold(fg(TEXT)("Harnez"))}${fg(DIM)(` v${VERSION}`)}${notice ? fg(WARNING)(` · ${notice}`) : ""}${fg(DIM)(`\n${model} · ${status}\n${path}`)}`
				.chunks,
		);
	}

	private fittingNotice() {
		const text = this.noticeText;
		if (!text) return undefined;
		const available = this.root.ctx.width - 5 - `Harnez v${VERSION} · `.length;
		return text.full.length <= available
			? text.full
			: text.short.length <= available
				? text.short
				: undefined;
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
