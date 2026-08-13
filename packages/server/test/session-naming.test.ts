import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import { SessionNamer, modelTitle, parseTitleSource, promptTitle, yakeTitle } from "../src/sessions/naming";
import { SettingsStore } from "../src/settings-store";

describe("session title settings", () => {
	test("defaults and independently overrides global title settings", () => {
		const dir = mkdtempSync(join(tmpdir(), "harnez-naming-"));
		const global = join(dir, "config/settings.json");
		const project = join(dir, ".harnez/settings.json");
		expect(new SettingsStore(global, project).sessionTitle()).toEqual({
			generated: true,
			source: "keywords/yake",
		});
		mkdirSync(join(dir, "config"));
		mkdirSync(join(dir, ".harnez"));
		writeFileSync(global, JSON.stringify({ session: { title: { generated: false, source: "keywords/yake" } } }));
		writeFileSync(project, JSON.stringify({ session: { title: { generated: true } } }));
		expect(new SettingsStore(global, project).sessionTitle()).toEqual({
			generated: true,
			source: "keywords/yake",
		});
	});
});

describe("title sources", () => {
	test("parses supported sources and rejects malformed ones", () => {
		expect(parseTitleSource("keywords/yake")).toEqual({ type: "keywords" });
		expect(parseTitleSource("model/openai/gpt-5.4/codex:high")).toEqual({
			type: "model", provider: "openai", model: "gpt-5.4/codex", thinkingLevel: "high",
		});
		expect(parseTitleSource("model/anthropic/claude")).toEqual({ type: "model", provider: "anthropic", model: "claude" });
		for (const source of ["prompt", "keywords", "model/x", "model/x/y:fast", "model/x/y:", "model/x/y:low:high"])
			expect(parseTitleSource(source)).toBeUndefined();
	});

	test("sanitizes prompt, YAKE, and model titles", () => {
		expect(promptTitle("  > ## Fix   parseThing() errors please  ")).toBe("Fix parseThing() errors please");
		expect(promptTitle(`Implement the session title generation flow while preserving the existing scheduling behavior and all user configuration settings.`)).toBe("Implement the session title generation flow while preserving the existing");
		expect(yakeTitle("Cloudflare Workers process requests close to users. Workers provide low latency for users.")).toBeTruthy();
		expect(modelTitle(' ## Title: "Repair the sessions store" ')).toBe("Repair the sessions store");
	});
});

describe("model naming", () => {
	test("uses an isolated concise request and falls back on non-stop responses", async () => {
		const calls: unknown[][] = [];
		const models = {
			getModel: () => ({ id: "title-model", provider: "fake", reasoning: true }),
			completeSimple: async (...args: unknown[]) => {
				calls.push(args);
				return { stopReason: "stop", content: [{ type: "text", text: "Title: Ship naming tests" }] };
			},
		} as unknown as Models;
		const namer = new SessionNamer(models, {} as never);
		expect(await namer.generate("Make title generation reliable", "model/fake/title-model:high")).toBe("Ship naming tests");
		expect(calls[0]?.[1]).toEqual({
			systemPrompt: "Create a concise session title. Return only the title, without quotes.",
			messages: [{ role: "user", content: "Make title generation reliable", timestamp: expect.any(Number) }],
		});
		expect(calls[0]?.[2]).toEqual({ maxTokens: 32, cacheRetention: "none", reasoning: "high" });

		const failing = new SessionNamer({ ...models, completeSimple: async () => ({ stopReason: "length", content: [] }) } as unknown as Models, {} as never);
		expect(await failing.generate("Keep the prompt fallback", "model/fake/title-model")).toBe("Keep the prompt fallback");
	});

	test("uses the supplied session registry for a named provider title model", async () => {
		const calls: unknown[] = [];
		const registry = {
			getModel: (provider: string, model: string) =>
				provider === "local" && model === "title-model"
					? { id: model, provider, reasoning: true }
					: undefined,
			completeSimple: async (model: unknown) => {
				calls.push(model);
				return { stopReason: "stop", content: [{ type: "text", text: "Local title" }] };
			},
		} as unknown as Models;
		const namer = new SessionNamer({ getModel: () => undefined } as unknown as Models, {} as never);
		expect(await namer.generate("Make a title", "model/local/title-model", undefined, registry)).toBe("Local title");
		expect(calls).toEqual([expect.objectContaining({ provider: "local", id: "title-model" })]);
	});
});
