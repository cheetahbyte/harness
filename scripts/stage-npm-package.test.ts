import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, stageNpmPackage } from "./stage-npm-package";

const directories: string[] = [];

function tempDir() {
	const directory = mkdtempSync(join(tmpdir(), "harnez-stage-test-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("stageNpmPackage", () => {
	test("stages platform packages and a root launcher package without mutating the repo", () => {
		const root = tempDir();
		const output = join(root, "dist");
		const sourceManifest =
			'{"name":"harnez","version":"1.2.3","license":"MIT","repository":{"type":"git","url":"https://github.com/cheetahbyte/harnez.git"}}\n';
		writeFileSync(join(root, "package.json"), sourceManifest);
		writeFileSync(join(root, "README.md"), "readme\n");
		mkdirSync(join(root, "bin"));
		writeFileSync(join(root, "bin", "harnez.js"), "launcher\n");
		writeFileSync(join(root, "darwin"), "darwin binary");
		writeFileSync(join(root, "linux"), "linux binary");

		stageNpmPackage({
			output,
			rootDir: root,
			targets: [
				{ target: "darwin-arm64", binary: join(root, "darwin") },
				{ target: "linux-x64", binary: join(root, "linux") },
			],
		});

		expect(JSON.parse(readFileSync(join(output, "package.json"), "utf8"))).toMatchObject({
			name: "harnez",
			version: "1.2.3",
			bin: { harnez: "bin/harnez.js" },
			optionalDependencies: {
				"harnez-darwin-arm64": "npm:harnez@1.2.3-darwin-arm64",
				"harnez-linux-x64": "npm:harnez@1.2.3-linux-x64",
			},
		});
		expect(JSON.parse(readFileSync(join(output, "vendor/darwin-arm64/package.json"), "utf8"))).toMatchObject({
			name: "harnez",
			version: "1.2.3-darwin-arm64",
			os: ["darwin"],
			cpu: ["arm64"],
			repository: { type: "git", url: "https://github.com/cheetahbyte/harnez.git" },
		});
		expect(readFileSync(join(output, "vendor/linux-x64/bin/harnez"), "utf8")).toBe("linux binary");
		expect(readFileSync(join(output, "bin/harnez.js"), "utf8")).toBe("launcher\n");
		expect(readFileSync(join(root, "package.json"), "utf8")).toBe(sourceManifest);
	});

	test("accepts matched target and binary arguments", () => {
		expect(parseArgs(["--target", "linux-x64", "--binary", "build/harnez", "--output", "dist"])).toEqual({
			output: "dist",
			targets: [{ target: "linux-x64", binary: "build/harnez" }],
		});
		expect(parseArgs(["--target", "linux-x64", "--output", "dist"])).toEqual({
			output: "dist",
			targets: [{ target: "linux-x64" }],
		});
		expect(() =>
			parseArgs([
				"--target",
				"darwin-arm64",
				"--target",
				"linux-x64",
				"--binary",
				"build/harnez",
				"--output",
				"dist",
			]),
		).toThrow("Usage:");
	});

	test("stages a root package with aliases and no local binaries", () => {
		const root = tempDir();
		const output = join(root, "dist");
		writeFileSync(join(root, "package.json"), '{"name":"harnez","version":"1.2.3"}\n');

		stageNpmPackage({
			output,
			rootDir: root,
			targets: [{ target: "darwin-arm64" }, { target: "linux-x64" }],
			version: "2.0.0",
		});

		expect(JSON.parse(readFileSync(join(output, "package.json"), "utf8"))).toMatchObject({
			version: "2.0.0",
			optionalDependencies: {
				"harnez-darwin-arm64": "npm:harnez@2.0.0-darwin-arm64",
				"harnez-linux-x64": "npm:harnez@2.0.0-linux-x64",
			},
		});
	});
});
