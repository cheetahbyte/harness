import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

type Target = { target: string; binary?: string };

type RootManifest = {
	name: string;
	version: string;
	license?: string;
	repository?: unknown;
};

function targetPlatform(target: string) {
	const separator = target.lastIndexOf("-");
	if (separator <= 0 || separator === target.length - 1)
		throw new Error(`Invalid target: ${target}`);
	return { os: target.slice(0, separator), cpu: target.slice(separator + 1) };
}

function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function stageNpmPackage({
	targets,
	output,
	rootDir = process.cwd(),
	version,
}: {
	targets: Target[];
	output: string;
	rootDir?: string;
	version?: string;
}) {
	const root = JSON.parse(
		readFileSync(join(rootDir, "package.json"), "utf8"),
	) as RootManifest;
	const rootVersion = version ?? root.version;
	const optionalDependencies: Record<string, string> = {};

	for (const { target, binary } of targets) {
		const { os, cpu } = targetPlatform(target);
		const platformVersion = `${rootVersion}-${target}`;
		if (binary) {
			const platformDir = join(output, "vendor", target);
			mkdirSync(join(platformDir, "bin"), { recursive: true });
			copyFileSync(binary, join(platformDir, "bin", "harnez"));
			writeJson(join(platformDir, "package.json"), {
				name: root.name,
				version: platformVersion,
				...(root.repository ? { repository: root.repository } : {}),
				os: [os],
				cpu: [cpu],
				files: ["bin"],
				publishConfig: { access: "public" },
			});
		}
		optionalDependencies[`harnez-${target}`] = `npm:harnez@${platformVersion}`;
	}

	writeJson(join(output, "package.json"), {
		name: root.name,
		version: rootVersion,
		...(root.license ? { license: root.license } : {}),
		...(root.repository ? { repository: root.repository } : {}),
		bin: { harnez: "bin/harnez.js" },
		files: ["bin", "README.md"],
		optionalDependencies,
		publishConfig: { access: "public" },
	});

	for (const file of ["bin/harnez.js", "README.md"])
		if (existsSync(join(rootDir, file))) {
			const destination = join(output, file);
			mkdirSync(dirname(destination), { recursive: true });
			copyFileSync(join(rootDir, file), destination);
		}
}

function usage() {
	return "Usage: bun scripts/stage-npm-package.ts --target <platform> --binary <path> [--target <platform> --binary <path> ...] --output <directory>";
}

export function parseArgs(args: string[]) {
	const targets: string[] = [];
	const binaries: string[] = [];
	let output: string | undefined;
	for (let index = 0; index < args.length; index += 2) {
		const value = args[index + 1];
		if (!value) throw new Error(usage());
		switch (args[index]) {
			case "--target":
				targets.push(value);
				break;
			case "--binary":
				binaries.push(value);
				break;
			case "--output":
				output = value;
				break;
			default:
				throw new Error(usage());
		}
	}
	if (!output || (binaries.length !== 0 && targets.length !== binaries.length))
		throw new Error(usage());
	const staged: Target[] = [];
	for (const [index, target] of targets.entries()) {
		const binary = binaries[index];
		staged.push(binary === undefined ? { target } : { target, binary });
	}
	return { output, targets: staged };
}

if (import.meta.main) stageNpmPackage(parseArgs(Bun.argv.slice(2)));
