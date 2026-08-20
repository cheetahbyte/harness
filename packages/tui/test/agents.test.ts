import { describe, expect, test } from "bun:test";

import { formatElapsed, line } from "../src/components/agents";

describe("agents view", () => {
	test("formats elapsed time and tool subjects", () => {
		expect(formatElapsed(0)).toBe("0s");
		expect(formatElapsed(65_000)).toBe("1m 5s");
		const now = Date.parse("2026-08-20T00:01:05.000Z");
		expect(
			line(
				{
					id: "agent-1",
					profile: "explore",
					description: "Inspect files",
					state: "running",
					startedAt: "2026-08-20T00:00:00.000Z",
					toolSubject: "packages/tui/src/store.ts",
				},
				now,
			),
		).toBe("explore · Inspect files · 1m 5s · packages/tui/src/store.ts");
	});
});
