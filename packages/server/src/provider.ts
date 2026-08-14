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

import type { ModelConfig } from "../../shared/src/protocol";
import type {
	OpenAICompatibleProviderSettings,
	ProviderSettings,
} from "./settings-store";

export class HarnezProviderError extends Error {
	constructor(
		message: string,
		readonly kind: "configuration" | "authentication" | "runtime" = "runtime",
	) {
		super(message);
		this.name = "HarnezProviderError";
	}
}

/** Harnez owns credential persistence; Pi receives this narrow store only. */
export class JsonCredentialStore implements CredentialStore {
	private chain = Promise.resolve();
	constructor(private readonly path: string) {}
	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.chain.then(operation);
		this.chain = queued.then(
			() => {},
			() => {},
		);
		return queued;
	}
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
	private async write(data: Record<string, Credential>): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temp = `${this.path}.${crypto.randomUUID()}`;
		await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
		await rename(temp, this.path);
		await chmod(this.path, 0o600);
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
		await this.enqueue(async () => {
			options?.signal?.throwIfAborted();
			const data = await this.data();
			result = await fn(data[providerId]);
			options?.signal?.throwIfAborted();
			if (result !== undefined) data[providerId] = result;
			else result = data[providerId];
			await this.write(data);
		});
		return result;
	}
	async delete(
		providerId: string,
		options?: AuthOperationOptions,
	): Promise<void> {
		await this.enqueue(async () => {
			options?.signal?.throwIfAborted();
			const data = await this.data();
			delete data[providerId];
			options?.signal?.throwIfAborted();
			await this.write(data);
		});
	}
}

/** One shared Pi registry powers catalogs, login, and built-in runtime models. */
export function createHarnezModels(
	credentials: CredentialStore,
	providers: ProviderSettings = {},
): MutableModels {
	registerBunOAuthFlows();
	const models = builtinModels({ credentials });
	for (const [id, settings] of Object.entries(providers)) {
		if (id === "openai-compatible" || models.getProvider(id))
			throw new HarnezProviderError(
				`custom provider ID collides with existing provider: ${id}`,
				"configuration",
			);
		models.setProvider(openAICompatibleProvider(id, settings));
	}
	return models;
}

function openAICompatibleProvider(
	id: string,
	settings: OpenAICompatibleProviderSettings,
) {
	const models = settings.models.map((model) =>
		openAICompatibleModel(id, model, settings.baseUrl),
	);
	return createProvider({
		id,
		name: id,
		baseUrl: settings.baseUrl,
		auth: {
			apiKey:
				settings.auth === "none"
					? {
							name: `${id} (no authentication)`,
							resolve: async () => ({ auth: { apiKey: "unused" } }),
						}
					: {
							name: `${id} API key`,
							login: async (interaction) => {
								interaction.signal.throwIfAborted();
								const key = await interaction.prompt({
									type: "secret",
									message: `Enter ${id} API key`,
								});
								interaction.signal.throwIfAborted();
								return { type: "api_key", key };
							},
							resolve: async ({ credential }) =>
								credential?.key
									? { auth: { apiKey: credential.key } }
									: undefined,
						},
		},
		models,
		api: openAICompletionsApi(),
	});
}

function openAICompatibleModel(
	provider: string,
	id: string,
	baseUrl: string,
): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	};
}

export function providerModels(
	config: ModelConfig,
	credentials: CredentialStore,
	models: Models,
) {
	if (!config.model)
		throw new HarnezProviderError(
			"select a model with /model",
			"configuration",
		);
	if (config.provider === "openai-compatible") {
		if (!config.baseUrl)
			throw new HarnezProviderError(
				"openai-compatible requires a base URL",
				"configuration",
			);
		const model = openAICompatibleModel(
			"openai-compatible",
			config.model,
			config.baseUrl,
		);
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
								(await ctx.env("HARNEZ_OPENAI_API_KEY")) ??
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
			throw new HarnezProviderError("unknown OpenAI-compatible model");
		return { models: customModels, model: configuredModel };
	}
	const model = models.getModel(config.provider, config.model);
	if (!model)
		throw new HarnezProviderError(
			`unknown model ${config.provider}/${config.model}; use /model`,
			"configuration",
		);
	return { models, model };
}
