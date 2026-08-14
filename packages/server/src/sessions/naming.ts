import { extract } from "@ade_oshineye/yaket";
import {
	clampThinkingLevel,
	contentText,
	type Models,
	type ModelThinkingLevel,
	type ThinkingLevel,
} from "@earendil-works/pi-ai";

import type { ModelConfig } from "../../../shared/src/protocol";
import { log } from "../logger";
import { providerModels } from "../provider";

const titleLimit = 80;
const thinkingLevels = new Set<ModelThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export type TitleSource =
	| { type: "keywords" }
	| {
			type: "model";
			provider: string;
			model: string;
			thinkingLevel?: ModelThinkingLevel;
	  };

export function parseTitleSource(source: string): TitleSource | undefined {
	if (source === "keywords/yake") return { type: "keywords" };
	const match = /^model\/([^/]+)\/(.+)$/.exec(source);
	if (!match?.[1] || !match[2]) return undefined;
	const [model, thinking, ...extra] = match[2].split(":");
	if (!model || thinking === "" || extra.length > 0) return undefined;
	const thinkingLevel = thinking as ModelThinkingLevel | undefined;
	if (thinkingLevel && !thinkingLevels.has(thinkingLevel)) return undefined;
	return {
		type: "model",
		provider: match[1],
		model,
		...(thinkingLevel ? { thinkingLevel } : {}),
	};
}

export function promptTitle(prompt: string): string | undefined {
	return title(prompt.replace(/^\s*(?:(?:#{1,6}\s+)|(?:>\s?))+/, ""));
}

export function yakeTitle(prompt: string): string | undefined {
	const keywords = extract(prompt, { language: "en", n: 3, top: 5 });
	const first = keywords[0]?.[0];
	if (!first) return promptTitle(prompt);
	const used = new Set(first.toLocaleLowerCase().split(/\s+/));
	const second = keywords.slice(1).find(([keyword]) =>
		keyword
			.toLocaleLowerCase()
			.split(/\s+/)
			.every((word) => !used.has(word)),
	)?.[0];
	return title(second ? `${first} ${second}` : first) ?? promptTitle(prompt);
}

export class SessionNamer {
	constructor(
		private readonly models: Models,
		private readonly credentials: Parameters<typeof providerModels>[1],
	) {}

	async generate(
		prompt: string,
		source: string,
		activeModel?: ModelConfig,
		registry = this.models,
	): Promise<string | undefined> {
		const parsed = parseTitleSource(source);
		if (!parsed) {
			log.debug({ source }, "invalid session title source");
			return promptTitle(prompt);
		}
		if (parsed.type === "keywords") return yakeTitle(prompt);
		try {
			const config: ModelConfig = {
				provider: parsed.provider,
				model: parsed.model,
				...(parsed.thinkingLevel
					? { thinkingLevel: parsed.thinkingLevel }
					: {}),
				...(parsed.provider === "openai-compatible" &&
				activeModel?.provider === "openai-compatible" &&
				activeModel.baseUrl
					? { baseUrl: activeModel.baseUrl }
					: {}),
			};
			const { model, models } = providerModels(
				config,
				this.credentials,
				registry,
			);
			const thinking =
				parsed.thinkingLevel === "off" || !parsed.thinkingLevel
					? undefined
					: (clampThinkingLevel(model, parsed.thinkingLevel) as ThinkingLevel);
			const response = await models.completeSimple(
				model,
				{
					systemPrompt:
						"Create a concise session title. Return only the title, without quotes.",
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				},
				thinking === undefined
					? { maxTokens: 32, cacheRetention: "none" }
					: { maxTokens: 32, cacheRetention: "none", reasoning: thinking },
			);
			if (response.stopReason !== "stop") return promptTitle(prompt);
			return modelTitle(contentText(response.content)) ?? promptTitle(prompt);
		} catch (error) {
			log.debug({ error, source }, "session title model failed");
			return promptTitle(prompt);
		}
	}
}

export function modelTitle(value: string): string | undefined {
	return title(
		value
			.replace(/^\s*(?:(?:#{1,6}\s+)|(?:>\s?))+/, "")
			.replace(/^\s*title\s*:\s*/i, ""),
		true,
	);
}

function title(value: string, stripQuotes = false): string | undefined {
	const normalized = value
		.replace(/\s+/g, " ")
		.replace(/^\s*(?:#{1,6}\s+|>\s?)+/, "")
		.replace(/\s+#{1,6}\s*$/, "")
		.trim()
		.replace(stripQuotes ? /^["'“”‘’]+|["'“”‘’]+$/g : /$^/, "")
		.trim();
	if (!normalized) return undefined;
	if (normalized.length <= titleLimit) return normalized;
	const truncated = normalized.slice(0, titleLimit + 1);
	return (
		truncated.slice(0, truncated.lastIndexOf(" ")) ||
		normalized.slice(0, titleLimit)
	);
}
