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

type Settings = {
	model?: ModelConfig;
	fastCycle?: FastCycleEntry[];
	disableThinkingBlocks?: boolean;
	session?: { title?: { generated?: boolean; source?: string } };
};

/**
 * Config lives under `harnez`, but installs predating the rename wrote to
 * `harness`. An existing legacy file keeps being used — including for writes —
 * so upgrading never silently strands someone's credentials or settings.
 */
export function globalHarnezPath(file: string): string {
	const config = process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config");
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

	setModelConfig(model: ModelConfig): void {
		this.save("model", model);
	}

	/** The `Ctrl+P` cycle, in the order it was picked; empty when unconfigured. */
	fastCycle(): FastCycleEntry[] {
		return this.project.fastCycle ?? this.global.fastCycle ?? [];
	}

	setFastCycle(entries: FastCycleEntry[]): void {
		this.save("fastCycle", entries);
	}

	disableThinkingBlocks(): boolean {
		return (
			this.project.disableThinkingBlocks ??
			this.global.disableThinkingBlocks ??
			false
		);
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
	try {
		return JSON.parse(contents) as Settings;
	} catch (error) {
		throw new Error(
			`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function writeSettings(path: string, settings: Settings): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${crypto.randomUUID()}`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
	renameSync(temporary, path);
}
