import { homedir } from "node:os";
import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";
import type { TuiState } from "../store";

/** Blank columns kept between the session label and the notice beside it. */
const NOTICE_GAP = 4;

export class HeaderView {
	readonly root: BoxRenderable;
	private readonly label: TextRenderable;
	private readonly notice: TextRenderable;
	private labelText = "";
	private noticeText: { full: string; short: string } | undefined;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "row",
			justifyContent: "space-between",
			marginBottom: 1,
		});
		this.label = new TextRenderable(renderer, { fg: "#cdd6f4" });
		/**
		 * Right-aligned by the row's spacing and never cleared by `update`, so an
		 * availability notice stays visible without competing with session state
		 * for the left side of the header.
		 */
		this.notice = new TextRenderable(renderer, { content: "", fg: "#f9e2af" });
		this.root.add(this.label);
		this.root.add(this.notice);
	}

	setNotice(text: { full: string; short: string }) {
		this.noticeText = text;
		this.fitNotice();
	}

	update(state: TuiState) {
		this.labelText = `Harnez  ${state.sessionId}    ${state.running ? "running" : "idle"}    ${shortenPath(state.pwd)}`;
		this.label.content = this.labelText;
		this.fitNotice();
	}

	/**
	 * The row does not clip, so an oversized notice would overprint the session
	 * label rather than shrink. Choosing the widest form that still fits keeps
	 * the two apart at any terminal width, and dropping the notice entirely is
	 * better than a header that reads as corrupted.
	 */
	private fitNotice() {
		const available = this.root.ctx.width - this.labelText.length - NOTICE_GAP;
		const text = this.noticeText;
		this.notice.content = !text
			? ""
			: text.full.length <= available
				? text.full
				: text.short.length <= available
					? text.short
					: "";
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
