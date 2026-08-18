import { describe, expect, test } from "bun:test";
import { validateImages } from "../src/images";

const png = "iVBORw0KGgo=";

function image(id: number, bytes = 8) {
	const data = new Uint8Array(bytes);
	data.set([137, 80, 78, 71, 13, 10, 26, 10]);
	return {
		id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
		mimeType: "image/png" as const,
		data: Buffer.from(data).toString("base64"),
	};
}

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
	test("accepts exact count, per-image, and message boundaries", () => {
		expect(validateImages([image(1), image(2), image(3), image(4)])).toHaveLength(4);
		expect(validateImages([image(5, 8 * 1024 * 1024)])).toHaveLength(1);
		expect(
			validateImages([
				image(6, 8 * 1024 * 1024),
				image(7, 8 * 1024 * 1024),
				image(8, 4 * 1024 * 1024),
			]),
		).toHaveLength(3);
	});
	test("rejects each limit just over its boundary", () => {
		expect(() => validateImages([image(9, 8 * 1024 * 1024 + 1)])).toThrow(
			"8 MiB",
		);
		expect(() =>
			validateImages([
				image(10, 8 * 1024 * 1024),
				image(11, 8 * 1024 * 1024),
				image(12, 4 * 1024 * 1024 + 1),
			]),
		).toThrow("20 MiB");
	});
});
