import { describe, expect, test } from "bun:test";
import { assertTagMatchesVersion, tagVersion } from "./tag";

describe("tag version checks", () => {
	test("accepts v-prefixed and plain tags", () => {
		expect(tagVersion("v1.2.3")).toBe("1.2.3");
		expect(() => assertTagMatchesVersion("v1.2.3", "1.2.3")).not.toThrow();
		expect(() => assertTagMatchesVersion("1.2.3", "1.2.3")).not.toThrow();
	});

	test("rejects a tag with a different version", () => {
		expect(() => assertTagMatchesVersion("v1.2.4", "1.2.3")).toThrow(
			"package.json has version 1.2.3",
		);
	});
});
