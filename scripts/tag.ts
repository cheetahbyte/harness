import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function packageVersion(
	packageJsonPath = join(process.cwd(), "package.json"),
) {
	const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
		version?: unknown;
	};
	if (
		typeof packageJson.version !== "string" ||
		packageJson.version.length === 0
	)
		throw new Error(`${packageJsonPath} does not contain a valid version`);
	return packageJson.version;
}

export function tagVersion(tag: string) {
	const version = tag.startsWith("v") ? tag.slice(1) : tag;
	return version;
}

export function assertTagMatchesVersion(
	tag: string,
	version = packageVersion(),
) {
	if (tagVersion(tag) !== version)
		throw new Error(
			`Refusing to create tag ${tag}: package.json has version ${version}. ` +
				`Update package.json or tag the matching version (v${version}).`,
		);
}

export function assertTagAtCommit(tag: string, commit: string) {
	const manifest = execFileSync("git", ["show", `${commit}:package.json`], {
		encoding: "utf8",
	});
	const { version } = JSON.parse(manifest) as { version?: unknown };
	if (typeof version !== "string" || version.length === 0)
		throw new Error(
			`package.json at ${commit} does not contain a valid version`,
		);
	assertTagMatchesVersion(tag, version);
}

function main(args: string[]) {
	if (args[0] === "--commit") {
		const [commit, tag] = args.slice(1);
		if (!commit || !tag)
			throw new Error("Usage: bun scripts/tag.ts --commit <commit> <tag>");
		assertTagAtCommit(tag, commit);
		return;
	}
	// Keep the tag first so options such as `-m` cannot be mistaken for it.
	const [tag] = args;
	if (!tag || tag.startsWith("-"))
		throw new Error("Usage: bun scripts/tag.ts <tag> [git tag options]");
	assertTagMatchesVersion(tag);

	const result = spawnSync("git", ["tag", ...args], { stdio: "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

if (import.meta.main) {
	try {
		main(Bun.argv.slice(2));
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
