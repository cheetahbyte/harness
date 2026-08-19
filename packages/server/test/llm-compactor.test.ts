import { describe, expect, test } from "bun:test";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { compactWithLlm, type LlmCompactionRequest } from "../src/context/llm-compactor";

const model = { provider: "fake", id: "compact-model" } as Model<Api>;
const memory = {
	milestone: "ship compaction",
	completedWork: ["added strict protocol"],
	strategies: [],
	environmentChanges: [],
	constraints: [],
	openQuestions: [],
	references: ["src/context/llm-compactor.ts"],
};

function request(completeSimple: (...args: any[]) => Promise<any>, signal = new AbortController().signal): LlmCompactionRequest {
	return {
		messages: [{ role: "user", content: "history" }],
		anchors: ["preserve this"],
		targetMemoryTokens: 2_000,
		model,
		models: { completeSimple } as unknown as Models,
		signal,
	};
}

describe("compactWithLlm", () => {
	test("accepts one exact JSON object and uses bounded no-cache options", async () => {
		const calls: any[][] = [];
		const result = await compactWithLlm(request(async (...args: any[]) => {
			calls.push(args);
			return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify(memory) }] };
		}));

		expect(result).toEqual({ memory, provider: "fake", model: "compact-model" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.[2]).toEqual(expect.objectContaining({
			cacheRetention: "none",
			maxTokens: 2_500,
			sessionId: expect.any(String),
		}));
		expect(calls[0]?.[2].sessionId).not.toBe("");
	});

	for (const [name, text] of [
		["fenced JSON", `\`\`\`json\n${JSON.stringify(memory)}\n\`\`\``],
		["extra prose", `Here is the result: ${JSON.stringify(memory)}`],
		["invalid schema", JSON.stringify({ milestone: "missing required arrays" })],
	] as const) {
		test(`rejects ${name} after exactly two attempts`, async () => {
			const calls: any[][] = [];
			const result = await compactWithLlm(request(async (...args: any[]) => {
				calls.push(args);
				return { stopReason: "stop", content: [{ type: "text", text }] };
			}));

			expect(result).toBeUndefined();
			expect(calls).toHaveLength(2);
			expect(calls[0]?.[2]).toEqual(expect.objectContaining({ cacheRetention: "none", maxTokens: 2_500 }));
			expect(calls[1]?.[2]).toEqual(expect.objectContaining({ cacheRetention: "none", maxTokens: 2_500 }));
			expect(calls[0]?.[2].sessionId).toBeTruthy();
			expect(calls[1]?.[2].sessionId).toBeTruthy();
			expect(calls[0]?.[2].sessionId).not.toBe(calls[1]?.[2].sessionId);
		});
	}

	test("rejects non-text content after two attempts", async () => {
		let attempts = 0;
		const result = await compactWithLlm(request(async () => {
			attempts++;
			return { stopReason: "stop", content: [{ type: "image", data: "bad", mimeType: "image/png" }] };
		}));
		expect(result).toBeUndefined();
		expect(attempts).toBe(2);
	});

	test("propagates abort without retrying or mutating fallback state", async () => {
		let attempts = 0;
		const result = compactWithLlm(request(async () => {
			attempts++;
			throw new DOMException("Aborted", "AbortError");
		}));
		await expect(result).rejects.toMatchObject({ name: "AbortError" });
		expect(attempts).toBe(1);
	});
});
