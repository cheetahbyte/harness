import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalHarnezPath, projectHarnezPath } from "../src/settings-store";

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
