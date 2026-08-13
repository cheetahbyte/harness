import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { RGBA } from "@opentui/core";

/** Terminal palette intents stay readable when the terminal switches themes. */
export const TEXT = RGBA.defaultForeground();
export const DIM = RGBA.fromIndex(8);
export const ACCENT = RGBA.fromIndex(12);
export const CYAN = RGBA.fromIndex(14);
export const WARNING = RGBA.fromIndex(11);
export const ERROR = RGBA.fromIndex(9);
export const USER_TEXT = RGBA.fromHex("#f4f7fb");
export const USER_BACKGROUND = RGBA.fromHex("#263449");

export function thinkingColor(level?: ModelThinkingLevel): RGBA {
	return (
		{
			off: DIM,
			minimal: RGBA.fromIndex(6),
			low: CYAN,
			medium: ACCENT,
			high: RGBA.fromIndex(13),
			xhigh: WARNING,
			max: ERROR,
		}[level ?? "off"] ?? DIM
	);
}
