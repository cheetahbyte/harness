import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { FastCycleEntry, ModelConfig } from "../../shared/src/protocol";

export type OpenAICompatibleProviderSettings = {
	type: "openai-compatible";
	baseUrl: string;
	auth: "none" | "api-key";
	models: string[];
};

export type ProviderSettings = Record<string, OpenAICompatibleProviderSettings>;

type Settings = {
	model?: ModelConfig;
	compaction?: {
		enabled?: boolean;
		model?: string;
	};
	/** Legacy spelling retained when reading older settings files. */
	compactionModel?: string;
	fastCycle?: FastCycleEntry[];
	disableThinkingBlocks?: boolean;
	disabledMcpServers?: string[];
	session?: { title?: { generated?: boolean; source?: string } };
	providers?: ProviderSettings;
	subagents?: { maxConcurrent?: number; maxDepth?: number };
};

/**
 * Config lives under `harnez`, but installs predating the rename wrote to
 * `harness`. An existing legacy file keeps being used — including for writes —
 * so upgrading never silently strands someone's credentials or settings.
 */
export function globalHarnezPath(file: string, home?: string): string {
	const config = home
		? join(home, ".config")
		: (process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"));
	const path = join(config, "harnez", file);
	if (existsSync(path)) return path;
	const legacy = join(config, "harness", file);
	return existsSync(legacy) ? legacy : path;
}

/** The workspace-local counterpart, with the same pre-rename fallback. */
export function projectHarnezPath(file: string, base = "."): string {
	const path = join(base, ".harnez", file);
	if (existsSync(path)) return path;
	const legacy = join(base, ".harness", file);
	return existsSync(legacy) ? legacy : path;
}

export class SettingsStore {
	private readonly global: Settings;
	private readonly project: Settings;

	constructor(
		private readonly globalPath = globalHarnezPath("settings.json"),
		private readonly projectPath = projectHarnezPath("settings.json"),
	) {
		this.global = readSettings(globalPath);
		this.project = readSettings(projectPath);
	}

	modelConfig(): ModelConfig | undefined {
		return this.project.model ?? this.global.model;
	}

	compactionModel(): string | undefined {
		return (
			this.project.compaction?.model ??
			this.global.compaction?.model ??
			this.project.compactionModel ??
			this.global.compactionModel
		);
	}

	compactionEnabled(): boolean {
		return (
			this.project.compaction?.enabled ??
			this.global.compaction?.enabled ??
			true
		);
	}

	setModelConfig(model: ModelConfig): void {
		this.save("model", model);
	}

	/** The `Ctrl+P` cycle, in the order it was picked; empty when unconfigured. */
	fastCycle(): FastCycleEntry[] {
		return this.project.fastCycle ?? this.global.fastCycle ?? [];
	}

	providers(): ProviderSettings {
		return copyProviders({
			...this.global.providers,
			...this.project.providers,
		});
	}

	setFastCycle(entries: FastCycleEntry[]): void {
		this.save("fastCycle", entries);
	}

	/**
	 * Servers switched off in the MCP menu. The list is of exclusions rather than
	 * inclusions so a server added to `mcp.json` later starts out connected.
	 */
	disabledMcpServers(): string[] {
		return (
			this.project.disabledMcpServers ?? this.global.disabledMcpServers ?? []
		);
	}

	setDisabledMcpServers(servers: string[]): void {
		this.save("disabledMcpServers", [...new Set(servers)].toSorted());
	}

	disableThinkingBlocks(): boolean {
		return (
			this.project.disableThinkingBlocks ??
			this.global.disableThinkingBlocks ??
			false
		);
	}

	subagents(): { maxConcurrent: number; maxDepth: number } {
		const settings = { ...this.global.subagents, ...this.project.subagents };
		return {
			maxConcurrent: boundedSetting(
				settings.maxConcurrent,
				"subagents.maxConcurrent",
				16,
				1,
				64,
			),
			maxDepth: boundedSetting(
				settings.maxDepth,
				"subagents.maxDepth",
				2,
				1,
				8,
			),
		};
	}

	sessionTitle(): { generated: boolean; source: string } {
		return {
			generated:
				this.project.session?.title?.generated ??
				this.global.session?.title?.generated ??
				true,
			source:
				this.project.session?.title?.source ??
				this.global.session?.title?.source ??
				"keywords/yake",
		};
	}

	setDisableThinkingBlocks(disabled: boolean): void {
		this.save("disableThinkingBlocks", disabled);
	}

	private save<K extends keyof Settings>(key: K, value: Settings[K]): void {
		const project = existsSync(this.projectPath);
		const settings = project ? this.project : this.global;
		settings[key] = value;
		writeSettings(project ? this.projectPath : this.globalPath, settings);
	}
}

function readSettings(path: string): Settings {
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return {};
	}
	let settings: Settings;
	try {
		settings = JSON.parse(contents) as Settings;
	} catch (error) {
		throw new Error(
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	const validated =
		settings.providers === undefined
			? settings
			: { ...settings, providers: readProviders(settings.providers, path) };
	if (validated.subagents !== undefined && !isRecord(validated.subagents))
		throw new Error(`${path}: subagents must be an object`);
	if (validated.subagents) {
		boundedSetting(
			validated.subagents.maxConcurrent,
			"subagents.maxConcurrent",
			16,
			1,
			64,
			path,
		);
		boundedSetting(
			validated.subagents.maxDepth,
			"subagents.maxDepth",
			2,
			1,
			8,
			path,
		);
	}
	return validated;
}

function boundedSetting(
	value: unknown,
	name: string,
	fallback: number,
	minimum: number,
	maximum: number,
	path?: string,
): number {
	if (value === undefined) return fallback;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw new Error(
			`${path ? `${path}: ` : ""}${name} must be an integer from ${minimum} through ${maximum}`,
		);
	return value;
}

function readProviders(value: unknown, path: string): ProviderSettings {
	if (value === undefined) return {};
	if (!isRecord(value)) throw new Error(`${path}: providers must be an object`);

	const providers: ProviderSettings = {};
	for (const [id, provider] of Object.entries(value)) {
		if (!id.trim())
			throw new Error(`${path}: provider "${id}" ID must not be blank`);
		if (!isRecord(provider))
			throw new Error(`${path}: provider "${id}" must be an object`);
		if (provider["type"] !== "openai-compatible")
			throw new Error(
				`${path}: provider "${id}" type must be "openai-compatible"`,
			);
		if (!isHttpUrl(provider["baseUrl"]))
			throw new Error(
				`${path}: provider "${id}" baseUrl must be an HTTP(S) URL`,
			);
		if (provider["auth"] !== "none" && provider["auth"] !== "api-key")
			throw new Error(
				`${path}: provider "${id}" auth must be "none" or "api-key"`,
			);
		if (
			!Array.isArray(provider["models"]) ||
			provider["models"].length === 0 ||
			!provider["models"].every((model) => typeof model === "string")
		)
			throw new Error(
				`${path}: provider "${id}" models must be a non-empty array`,
			);
		if (provider["models"].some((model) => !model.trim()))
			throw new Error(`${path}: provider "${id}" model IDs must not be blank`);
		if (new Set(provider["models"]).size !== provider["models"].length)
			throw new Error(`${path}: provider "${id}" model IDs must be unique`);

		providers[id] = {
			type: provider["type"],
			baseUrl: provider["baseUrl"],
			auth: provider["auth"],
			models: [...provider["models"]],
		};
	}
	return providers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const { protocol } = new URL(value);
		return protocol === "http:" || protocol === "https:";
	} catch {
		return false;
	}
}

function copyProviders(providers: ProviderSettings): ProviderSettings {
	return Object.fromEntries(
		Object.entries(providers).map(([id, provider]) => [
			id,
			{ ...provider, models: [...provider.models] },
		]),
	);
}

function writeSettings(path: string, settings: Settings): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${crypto.randomUUID()}`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
	renameSync(temporary, path);
}
