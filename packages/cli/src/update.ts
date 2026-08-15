import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { VERSION } from "../../shared/src/version";
import { type Health, restartServer } from "./server-command";

const PACKAGE_NAME = "harnez";
const REGISTRY_TIMEOUT_MS = 5_000;

export type InstallCommand = { command: string[]; manager: string };

function registryUrl(): string {
	return process.env["HARNEZ_REGISTRY"] ?? "https://registry.npmjs.org";
}

/**
 * Resolves the version behind the `latest` dist-tag. npm picks the matching
 * platform binary through the optional dependencies, so "latest" is already the
 * latest release compatible with this machine.
 */
export async function latestVersion(signal?: AbortSignal): Promise<string> {
	const response = await fetch(
		new URL(`/${PACKAGE_NAME}/latest`, registryUrl()),
		{
			headers: { accept: "application/json" },
			signal: signal ?? AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
		},
	);
	if (!response.ok)
		throw new Error(
			`registry returned ${response.status} for ${PACKAGE_NAME}@latest`,
		);
	const body = (await response.json().catch(() => undefined)) as
		| { version?: unknown }
		| undefined;
	if (typeof body?.version !== "string" || !body.version)
		throw new Error(`registry returned no version for ${PACKAGE_NAME}@latest`);
	return body.version;
}

/**
 * Orders release versions, treating a prerelease as older than the release it
 * leads to so `0.2.0-rc.1` never looks like an update over `0.2.0`. Identifiers
 * compare numerically when both sides are numeric and lexically otherwise,
 * which is the semver rule this project's tags actually exercise.
 */
export function compareVersions(left: string, right: string): number {
	const [leftCore = "", leftPre] = splitPrerelease(left);
	const [rightCore = "", rightPre] = splitPrerelease(right);
	const leftParts = leftCore.split(".");
	const rightParts = rightCore.split(".");
	for (
		let index = 0;
		index < Math.max(leftParts.length, rightParts.length);
		index++
	) {
		const difference =
			Number(leftParts[index] ?? 0) - Number(rightParts[index] ?? 0);
		if (difference) return Math.sign(difference);
	}
	if (leftPre === undefined && rightPre === undefined) return 0;
	if (leftPre === undefined) return 1;
	if (rightPre === undefined) return -1;
	const leftIds = leftPre.split(".");
	const rightIds = rightPre.split(".");
	for (
		let index = 0;
		index < Math.max(leftIds.length, rightIds.length);
		index++
	) {
		const a = leftIds[index];
		const b = rightIds[index];
		if (a === undefined) return -1;
		if (b === undefined) return 1;
		const numeric = /^\d+$/.test(a) && /^\d+$/.test(b);
		if (a !== b)
			return numeric ? Math.sign(Number(a) - Number(b)) : a < b ? -1 : 1;
	}
	return 0;
}

function splitPrerelease(version: string): [string, string?] {
	const trimmed = version.trim().replace(/^v/, "");
	const separator = trimmed.indexOf("-");
	return separator === -1
		? [trimmed]
		: [trimmed.slice(0, separator), trimmed.slice(separator + 1)];
}

/**
 * Picks the package manager from where the running binary lives. Global install
 * roots are distinctive enough to identify, and guessing wrong only means the
 * user is told which command to run instead of it running for them.
 */
export function installCommand(
	version: string,
	executable = process.execPath,
): InstallCommand {
	const specifier = `${PACKAGE_NAME}@${version}`;
	const path = executable.replaceAll("\\", "/");
	if (path.includes("/.bun/"))
		return { manager: "bun", command: ["bun", "add", "--global", specifier] };
	if (/\/(pnpm|\.pnpm)\//.test(path))
		return { manager: "pnpm", command: ["pnpm", "add", "--global", specifier] };
	if (path.includes("/.yarn/"))
		return { manager: "yarn", command: ["yarn", "global", "add", specifier] };
	return { manager: "npm", command: ["npm", "install", "--global", specifier] };
}

/**
 * Reads the version of the platform package the running binary was loaded from.
 * Its manifest is versioned `<release>-<target>`, so the release is recoverable
 * by dropping the target suffix. Returns undefined when the layout is not the
 * published one, which is the case in a source checkout.
 */
export function installedVersion(
	executable = process.execPath,
): string | undefined {
	try {
		const manifest = JSON.parse(
			readFileSync(join(dirname(dirname(executable)), "package.json"), "utf8"),
		) as { name?: unknown; version?: unknown };
		if (manifest.name !== PACKAGE_NAME || typeof manifest.version !== "string")
			return undefined;
		const target = `-${process.platform}-${process.arch}`;
		return manifest.version.endsWith(target)
			? manifest.version.slice(0, -target.length)
			: manifest.version;
	} catch {
		return undefined;
	}
}

/**
 * Explains why this installation cannot update itself, or undefined when it
 * can. A source checkout and a hand-placed binary both run code that no package
 * manager owns, so installing a release would not replace what is running.
 */
function updateBlocker(): string | undefined {
	if (process.env["HARNEZ_BINARY"])
		return "HARNEZ_BINARY points at a binary Harnez does not manage; replace it yourself or unset HARNEZ_BINARY";
	if (!process.argv[1]?.startsWith("/$bunfs/"))
		return "Harnez is running from a source checkout; update it with git instead";
	return undefined;
}

export async function runUpdateCommand(): Promise<void> {
	const current = VERSION;
	console.log(`Harnez ${current} installed, checking for updates…`);
	let latest: string;
	try {
		latest = await latestVersion();
	} catch (error) {
		throw new Error(
			`could not reach the npm registry: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	if (compareVersions(latest, current) <= 0) {
		console.log(`Harnez is up to date (${current})`);
		return;
	}

	const blocker = updateBlocker();
	if (blocker) throw new Error(`${blocker} (Harnez ${latest} is available)`);

	const { command, manager } = installCommand(latest);
	console.log(`Updating Harnez ${current} → ${latest} with ${manager}…`);
	let exitCode: number;
	try {
		exitCode = await Bun.spawn(command, {
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		}).exited;
	} catch (error) {
		throw new Error(
			`could not run \`${command.join(" ")}\`: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	if (exitCode !== 0)
		throw new Error(
			`\`${command.join(" ")}\` exited with code ${exitCode}; Harnez was not updated`,
		);

	/**
	 * Only a version that positively disagrees with the target blocks the
	 * restart. An unreadable manifest means the layout is unfamiliar, not that
	 * the install failed, and the exit code above already covers failure.
	 */
	const installed = installedVersion();
	if (installed !== undefined && compareVersions(installed, latest) !== 0)
		throw new Error(
			`update reported success but ${installed} is installed, not ${latest}; the Harnez server was left running on ${current}`,
		);
	console.log(`Harnez updated to ${latest}`);

	await restartUpdatedServer(current, latest);
}

/**
 * Restarts the server so the new build serves the next session. A server that
 * was not running needs nothing, and a restart failure must not read as a
 * failed update, because the update already succeeded.
 */
async function restartUpdatedServer(
	current: string,
	latest: string,
): Promise<void> {
	let running: Health | undefined;
	try {
		running = await restartServer();
	} catch (error) {
		console.error(
			`Harnez ${latest} is installed, but restarting the server failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
		console.error("Run `harnez server restart` to finish switching over.");
		return;
	}
	console.log(
		running
			? `Harnez server restarted on ${latest} (pid ${running.pid})`
			: `No Harnez server was running; the next one starts on ${latest} instead of ${current}`,
	);
}
