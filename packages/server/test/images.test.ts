import { describe, expect, test } from "bun:test";
import { validateImages } from "../src/images";

const png = "iVBORw0KGgo=";

describe("image validation", () => {
	test("accepts and clones supported image data", () => {
		const input = [{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/png" as const, data: png }];
		const output = validateImages(input);
		expect(output).toEqual(input);
		expect(output).not.toBe(input);
	});
	test("rejects malformed, mismatched, and empty data", () => {
		expect(() => validateImages([{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/png", data: "bad" }])).toThrow("base64");
		expect(() => validateImages([{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/jpeg", data: png }])).toThrow("MIME");
		expect(() => validateImages([{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/jpeg", data: "" }])).toThrow("empty");
	});
	test("enforces count and per-image limits", () => {
		const many = Array.from({ length: 5 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, mimeType: "image/png", data: png }));
		expect(() => validateImages(many)).toThrow("at most");
		const oversized = `${png}${"A".repeat(11_184_808)}`;
		expect(() => validateImages([{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/png", data: oversized }])).toThrow();
	});
});
