import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	globalHarnezPath,
	projectHarnezPath,
	SettingsStore,
} from "../src/settings-store";

const paths: string[] = [];
const originalConfigHome = process.env["XDG_CONFIG_HOME"];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
	if (originalConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
	else process.env["XDG_CONFIG_HOME"] = originalConfigHome;
});

function workspace() {
	const dir = mkdtempSync(join(tmpdir(), "harnez-paths-"));
	paths.push(dir);
	return dir;
}

function settings(dir: string, name: string) {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "settings.json"), "{}\n");
}

function settingsFile(dir: string, name: string, value: unknown) {
	const path = join(dir, name);
	writeFileSync(path, JSON.stringify(value));
	return path;
}

test("global config resolves to harnez, falling back to the pre-rename harness", () => {
	const config = workspace();
	process.env["XDG_CONFIG_HOME"] = config;
	/** Neither exists yet, so a fresh install writes the new location. */
	expect(globalHarnezPath("settings.json")).toBe(
		join(config, "harnez", "settings.json"),
	);

	settings(config, "harness");
	expect(globalHarnezPath("settings.json")).toBe(
		join(config, "harness", "settings.json"),
	);

	/** Once the new file exists it wins, even with the legacy one still present. */
	settings(config, "harnez");
	expect(globalHarnezPath("settings.json")).toBe(
		join(config, "harnez", "settings.json"),
	);
});

test("project config resolves to .harnez, falling back to the pre-rename .harness", () => {
	const project = workspace();
	expect(projectHarnezPath("settings.json", project)).toBe(
		join(project, ".harnez", "settings.json"),
	);

	settings(project, ".harness");
	expect(projectHarnezPath("settings.json", project)).toBe(
		join(project, ".harness", "settings.json"),
	);

	settings(project, ".harnez");
	expect(projectHarnezPath("settings.json", project)).toBe(
		join(project, ".harnez", "settings.json"),
	);
});

test("providers merge by ID, with project entries replacing global entries", () => {
	const dir = workspace();
	const global = settingsFile(dir, "global.json", {
		providers: {
			local: {
				type: "openai-compatible",
				baseUrl: "http://localhost:11434/v1",
				auth: "none",
				models: ["qwen3-coder:30b"],
			},
			company: {
				type: "openai-compatible",
				baseUrl: "https://global.example/v1",
				auth: "none",
				models: ["old-coder"],
			},
		},
	});
	const project = settingsFile(dir, "project.json", {
		providers: {
			company: {
				type: "openai-compatible",
				baseUrl: "https://project.example/v1",
				auth: "api-key",
				models: ["coder"],
			},
		},
	});

	const store = new SettingsStore(global, project);
	expect(store.providers()).toEqual({
		local: {
			type: "openai-compatible",
			baseUrl: "http://localhost:11434/v1",
			auth: "none",
			models: ["qwen3-coder:30b"],
		},
		company: {
			type: "openai-compatible",
			baseUrl: "https://project.example/v1",
			auth: "api-key",
			models: ["coder"],
		},
	});

	const providers = store.providers();
	providers["local"]?.models.push("mutated");
	expect(store.providers()["local"]?.models).toEqual(["qwen3-coder:30b"]);
});

test("compaction model uses project settings before global settings", () => {
	const dir = workspace();
	const global = settingsFile(dir, "global.json", {
		compactionModel: "ollama/qwen2.5:7b",
	});
	const project = settingsFile(dir, "project.json", {
		compactionModel: "company/summarizer",
	});

	const store = new SettingsStore(global, project);
	expect(store.compactionModel()).toBe("company/summarizer");
});

test.each([
	[[], "providers must be an object"],
	[{ " ": {} }, 'provider " " ID must not be blank'],
	[
		{ local: { type: "other", baseUrl: "https://example.com", auth: "none", models: ["model"] } },
		'provider "local" type must be "openai-compatible"',
	],
	[
		{ local: { type: "openai-compatible", baseUrl: "/v1", auth: "none", models: ["model"] } },
		'provider "local" baseUrl must be an HTTP(S) URL',
	],
	[
		{ local: { type: "openai-compatible", baseUrl: "https://example.com", auth: "token", models: ["model"] } },
		'provider "local" auth must be "none" or "api-key"',
	],
	[
		{ local: { type: "openai-compatible", baseUrl: "https://example.com", auth: "none", models: [] } },
		'provider "local" models must be a non-empty array',
	],
	[
		{ local: { type: "openai-compatible", baseUrl: "https://example.com", auth: "none", models: [" "] } },
		'provider "local" model IDs must not be blank',
	],
	[
		{ local: { type: "openai-compatible", baseUrl: "https://example.com", auth: "none", models: ["model", "model"] } },
		'provider "local" model IDs must be unique',
	],
])("rejects invalid provider settings", (providers, message) => {
	const dir = workspace();
	const path = settingsFile(dir, "settings.json", { providers });
	expect(() => new SettingsStore(path, join(dir, "missing.json"))).toThrow(
		`${path}: ${message}`,
	);
});
