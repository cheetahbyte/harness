import { describe, expect, test } from "bun:test";

import { getFrontmatterSlug } from "./frontmatter";

describe("getFrontmatterSlug", () => {
	test("reads a nested slug", () => {
		expect(
			getFrontmatterSlug(
				"---\ntitle: Context Compaction\nslug: architecture/context-compaction\n---\n",
			),
		).toBe("architecture/context-compaction");
	});

	test("rejects a missing slug", () => {
		expect(() => getFrontmatterSlug("---\ntitle: Missing\n---\n")).toThrow(
			"slug",
		);
	});
});
