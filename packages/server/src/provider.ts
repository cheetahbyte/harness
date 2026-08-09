import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type AuthOperationOptions,
	type Credential,
	type CredentialInfo,
	type CredentialStore,
	createModels,
	createProvider,
	type Model,
	type Models,
	type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export type HarnessModelConfig = {
	provider: string;
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
	async read(
		providerId: string,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		return (await this.data())[providerId];
	}
	async list(
		options?: AuthOperationOptions,
	): Promise<readonly CredentialInfo[]> {
		options?.signal?.throwIfAborted();
		return Object.entries(await this.data()).map(
			([providerId, credential]) => ({ providerId, type: credential.type }),
		);
	}
	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		let result: Credential | undefined;
		const operation = this.chain.then(async () => {
			options?.signal?.throwIfAborted();
			const data = await this.data();
			result = await fn(data[providerId]);
			options?.signal?.throwIfAborted();
			if (result !== undefined) data[providerId] = result;
			else result = data[providerId];
			await mkdir(dirname(this.path), { recursive: true });
			const temp = `${this.path}.${crypto.randomUUID()}`;
			await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
			await rename(temp, this.path);
			await chmod(this.path, 0o600);
		});
		this.chain = operation.then(
			() => {},
			() => {},
		);
		await operation;
		return result;
	}
	async delete(
		providerId: string,
		options?: AuthOperationOptions,
	): Promise<void> {
		const operation = this.chain.then(async () => {
			options?.signal?.throwIfAborted();
			const data = await this.data();
			delete data[providerId];
			options?.signal?.throwIfAborted();
			await mkdir(dirname(this.path), { recursive: true });
			const temp = `${this.path}.${crypto.randomUUID()}`;
			await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
			await rename(temp, this.path);
			await chmod(this.path, 0o600);
		});
		this.chain = operation.then(
			() => {},
			() => {},
		);
		await operation;
	}
}

/** One shared Pi registry powers catalogs, login, and built-in runtime models. */
export function createHarnessModels(
	credentials: CredentialStore,
): MutableModels {
	registerBunOAuthFlows();
	return builtinModels({ credentials });
}

export function providerModels(
	config: HarnessModelConfig,
	credentials: CredentialStore,
	models: Models,
) {
	if (!config.model)
		throw new HarnessProviderError(
			"select a model with /model",
			"configuration",
		);
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
		const customModels = createModels({ credentials });
		customModels.setProvider(
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
		const configuredModel = customModels.getModel(
			config.provider,
			config.model,
		);
		if (!configuredModel)
			throw new HarnessProviderError("unknown OpenAI-compatible model");
		return { models: customModels, model: configuredModel };
	}
	const model = models.getModel(config.provider, config.model);
	if (!model)
		throw new HarnessProviderError(
			`unknown model ${config.provider}/${config.model}; use /model`,
			"configuration",
		);
	return { models, model };
}
