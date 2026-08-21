import { expect, test } from "bun:test";

import { subagentPrompt } from "../src/sessions/task-runner";

test("tells a child to execute instead of repeating the parent's launch message", () => {
	const prompt = subagentPrompt(
		{ name: "general-purpose", body: "Complete the work package." },
		"List packages under docs/.",
	);

	expect(prompt).toContain("already running as the general-purpose subagent");
	expect(prompt).toContain("do not delegate it or merely announce");
	expect(prompt).toContain("List packages under docs/.");
	expect(prompt).toContain("call submit_subagent_result exactly once");
});
