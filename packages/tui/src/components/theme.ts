import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { RGBA } from "@opentui/core";

/** Terminal palette intents stay readable when the terminal switches themes. */
export const TEXT = RGBA.defaultForeground();
export const DIM = RGBA.fromIndex(8);
export const ACCENT = RGBA.fromIndex(12);
export const CYAN = RGBA.fromIndex(14);
export const WARNING = RGBA.fromIndex(11);
export const ERROR = RGBA.fromIndex(9);
export const USER_TEXT = RGBA.fromHex("#ffffff");
export const USER_BACKGROUND = RGBA.fromHex("#373737");
/**
 * The prompt marker reads as an echo of what was typed, so it sits just above
 * its own background rather than competing with the message for attention.
 */
export const USER_PROMPT = RGBA.fromHex("#505050");
export const USER_PROMPT_PENDING = RGBA.fromHex("#414141");

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
