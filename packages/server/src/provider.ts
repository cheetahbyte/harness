import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createProvider,
	type Model,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export type HarnessModelConfig = {
	provider: "openai-codex" | "openai-compatible";
	model: string;
	baseUrl?: string;
};
export class HarnessProviderError extends Error {
	constructor(
		message: string,
		readonly kind: "configuration" | "authentication" | "runtime" = "runtime",
	) {
		super(message);
		this.name = "HarnessProviderError";
	}
}

/** Harness owns credential persistence; Pi receives this narrow store only. */
export class JsonCredentialStore implements CredentialStore {
	private chain = Promise.resolve();
	constructor(private readonly path: string) {}
	private async data(): Promise<Record<string, Credential>> {
		try {
			return JSON.parse(await readFile(this.path, "utf8")) as Record<
				string,
				Credential
			>;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}
	async read(providerId: string): Promise<Credential | undefined> {
		return (await this.data())[providerId];
	}
	async list(): Promise<readonly CredentialInfo[]> {
		return Object.entries(await this.data()).map(
			([providerId, credential]) => ({ providerId, type: credential.type }),
		);
	}
	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
	): Promise<Credential | undefined> {
		let result: Credential | undefined;
		this.chain = this.chain.then(async () => {
			const data = await this.data();
			result = await fn(data[providerId]);
			if (result) data[providerId] = result;
			await mkdir(dirname(this.path), { recursive: true });
			const temp = `${this.path}.${crypto.randomUUID()}`;
			await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
			await rename(temp, this.path);
			await chmod(this.path, 0o600);
		});
		await this.chain;
		return result;
	}
	async delete(providerId: string): Promise<void> {
		this.chain = this.chain.then(async () => {
			const data = await this.data();
			delete data[providerId];
			await mkdir(dirname(this.path), { recursive: true });
			const temp = `${this.path}.${crypto.randomUUID()}`;
			await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
			await rename(temp, this.path);
			await chmod(this.path, 0o600);
		});
		await this.chain;
	}
}

export function providerModels(
	config: HarnessModelConfig,
	credentials: CredentialStore,
) {
	registerBunOAuthFlows();
	if (!config.model)
		throw new HarnessProviderError(
			"select a model with /model <openai-codex|openai-compatible> <model> [base-url]",
			"configuration",
		);
	const models = builtinModels({ credentials });
	if (config.provider === "openai-compatible") {
		if (!config.baseUrl)
			throw new HarnessProviderError(
				"openai-compatible requires a base URL",
				"configuration",
			);
		const model: Model<"openai-completions"> = {
			id: config.model,
			name: config.model,
			api: "openai-completions",
			provider: "openai-compatible",
			baseUrl: config.baseUrl,
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		};
		models.setProvider(
			createProvider({
				id: "openai-compatible",
				name: "OpenAI-compatible",
				baseUrl: config.baseUrl,
				auth: {
					apiKey: {
						name: "OpenAI-compatible API key",
						resolve: async ({ ctx, credential }) => {
							const apiKey =
								credential?.key ??
								(await ctx.env("HARNESS_OPENAI_API_KEY")) ??
								(await ctx.env("OPENAI_API_KEY"));
							return apiKey ? { auth: { apiKey } } : undefined;
						},
					},
				},
				models: [model],
				api: openAICompletionsApi(),
			}),
		);
	}
	const model = models.getModel(config.provider, config.model);
	if (!model)
		throw new HarnessProviderError(
			`unknown model ${config.provider}/${config.model}`,
			"configuration",
		);
	return { models, model };
}
