import type { Api, Context, Model, Models } from "@earendil-works/pi-ai";

import {
	validateCondensationInput,
	type CondensationInput,
} from "./condensation";

export type LlmCompactionRequest = {
	messages: unknown[];
	previousMemory?: CondensationInput;
	anchors: string[];
	targetMemoryTokens: number;
	model: Model<Api>;
	models: Models;
	signal: AbortSignal;
};

export type CompactionDraft = {
	memory: CondensationInput;
	provider: string;
	model: string;
};

export type ContextCompactor = (
	request: LlmCompactionRequest,
) => Promise<CompactionDraft | undefined>;

const SYSTEM =
	"You are Harnez's context compactor. Return exactly one JSON object matching the requested schema. Do not use markdown fences, explanations, or tool calls. Preserve exact paths, identifiers, constraints, failures, and unresolved questions.";

/** LLM compaction protocol: one structured response, bounded output, no tools/cache. */
export async function compactWithLlm(
	request: LlmCompactionRequest,
): Promise<CompactionDraft | undefined> {
	if (request.signal.aborted) throw new DOMException("Aborted", "AbortError");
	const source = JSON.stringify({
		previousMemory: request.previousMemory ?? null,
		anchors: request.anchors,
		messages: request.messages,
		targetMemoryTokens: Math.min(2_000, request.targetMemoryTokens),
		schema: {
			milestone: "string",
			completedWork: ["string"],
			strategies: [{ approach: "string", outcome: "string" }],
			environmentChanges: ["string"],
			constraints: ["string"],
			openQuestions: ["string"],
			references: ["observation://... or relative/path"],
		},
	});
	let lastError: unknown;
	for (let attempt = 0; attempt < 2; attempt++) {
		request.signal.throwIfAborted();
		try {
			const response = await request.models.completeSimple(
				request.model,
				{
					systemPrompt: SYSTEM,
					messages: [
						{
							role: "user",
							content: [{ type: "text", text: source }],
							timestamp: Date.now(),
						},
					],
				} satisfies Context,
				{ maxTokens: 2_500, cacheRetention: "none", signal: request.signal },
			);
			if (response.stopReason === "aborted")
				throw new DOMException("Aborted", "AbortError");
			if (response.stopReason !== "stop")
				throw new Error(
					response.errorMessage ?? "compactor did not stop cleanly",
				);
			const text = response.content
				.filter(
					(part): part is { type: "text"; text: string } =>
						part.type === "text",
				)
				.map((part) => part.text)
				.join("")
				.trim();
			if (!text || text.startsWith("```") || text.endsWith("```"))
				throw new Error("compactor returned markdown or empty output");
			const parsed: unknown = JSON.parse(text);
			const memory = validateCondensationInput(parsed);
			return {
				memory,
				provider: request.model.provider,
				model: request.model.id,
			};
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError")
				throw error;
			lastError = error;
		}
	}
	void lastError;
	return undefined;
}
