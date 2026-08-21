import { expect, test } from "bun:test";

import { subagentStateAgent } from "../src/server";

test("replayed failed agents expose their handoff summary to the TUI", () => {
	expect(
		subagentStateAgent({
			id: "child-1",
			profile: "general-purpose",
			description: "List packages",
			state: "failed",
			result: { status: "failed", summary: "handoff failure details" },
		}),
	).toMatchObject({ state: "failed", summary: "handoff failure details" });
});
