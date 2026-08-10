import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelConfig } from "../../shared/src/protocol";

type Settings = { model?: ModelConfig; disableThinkingBlocks?: boolean };

export function globalHarnessPath(file: string): string {
	return join(
		process.env["XDG_CONFIG_HOME"] ?? join(homedir(), ".config"),
		"harness",
		file,
	);
}

export class SettingsStore {
	private readonly global: Settings;
	private readonly project: Settings;

	constructor(
		private readonly globalPath = globalHarnessPath("settings.json"),
		private readonly projectPath = ".harness/settings.json",
	) {
		this.global = readSettings(globalPath);
		this.project = readSettings(projectPath);
	}

	modelConfig(): ModelConfig | undefined {
		return this.project.model ?? this.global.model;
	}

	setModelConfig(model: ModelConfig): void {
		const project = existsSync(this.projectPath);
		const settings = project ? this.project : this.global;
		settings.model = model;
		writeSettings(project ? this.projectPath : this.globalPath, settings);
	}

	disableThinkingBlocks(): boolean {
		return (
			this.project.disableThinkingBlocks ??
			this.global.disableThinkingBlocks ??
			false
		);
	}

	setDisableThinkingBlocks(disabled: boolean): void {
		const project = existsSync(this.projectPath);
		const settings = project ? this.project : this.global;
		settings.disableThinkingBlocks = disabled;
		writeSettings(project ? this.projectPath : this.globalPath, settings);
	}
}

function readSettings(path: string): Settings {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as Settings;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return {};
	}
}

function writeSettings(path: string, settings: Settings): void {
	mkdirSync(dirname(path), { recursive: true });
	const temporary = `${path}.${crypto.randomUUID()}`;
	writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
	renameSync(temporary, path);
}
