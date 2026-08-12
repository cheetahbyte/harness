import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLatestVersion, updateNotice } from "../src/update-check";
import { compareVersions, installCommand, installedVersion } from "../src/update";

const paths: string[] = [];
const environment = new Map<string, string | undefined>();

function setEnvironment(name: string, value: string | undefined) {
	if (!environment.has(name)) environment.set(name, process.env[name]);
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function temporaryDirectory(): string {
	const directory = mkdtempSync(join(tmpdir(), "harnez-update-test-"));
	paths.push(directory);
	return directory;
}

/** A registry that answers the one route the update path asks for. */
function fakeRegistry(version: string) {
	return Bun.serve({
		port: 0,
		fetch: (request) =>
			new URL(request.url).pathname === "/harnez/latest"
				? Response.json({ version })
				: new Response("not found", { status: 404 }),
	});
}

afterEach(() => {
	for (const [name, value] of environment)
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	environment.clear();
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

describe("version ordering", () => {
	test("orders releases by each numeric part", () => {
		expect(compareVersions("0.2.0", "0.1.8")).toBe(1);
		expect(compareVersions("0.1.8", "0.2.0")).toBe(-1);
		expect(compareVersions("0.1.8", "0.1.8")).toBe(0);
		expect(compareVersions("0.10.0", "0.9.0")).toBe(1);
		expect(compareVersions("1.0.0", "0.99.99")).toBe(1);
	});

	test("treats a prerelease as older than its release", () => {
		expect(compareVersions("0.2.0-rc.1", "0.2.0")).toBe(-1);
		expect(compareVersions("0.2.0", "0.2.0-rc.1")).toBe(1);
		expect(compareVersions("0.2.0-rc.2", "0.2.0-rc.1")).toBe(1);
		expect(compareVersions("0.2.0-rc.10", "0.2.0-rc.2")).toBe(1);
		expect(compareVersions("0.2.0-rc.1", "0.1.8")).toBe(1);
	});

	test("ignores a leading v and surrounding space", () => {
		expect(compareVersions(" v0.2.0 ", "0.2.0")).toBe(0);
	});
});

describe("install command", () => {
	test("matches the package manager that owns the running binary", () => {
		expect(
			installCommand("0.2.0", "/home/a/.bun/install/global/node_modules/x/bin/harnez")
				.manager,
		).toBe("bun");
		expect(
			installCommand("0.2.0", "/home/a/Library/pnpm/global/5/node_modules/x/bin/harnez")
				.manager,
		).toBe("pnpm");
		const npm = installCommand(
			"0.2.0",
			"/usr/local/lib/node_modules/harnez/node_modules/harnez-linux-x64/bin/harnez",
		);
		expect(npm.manager).toBe("npm");
		expect(npm.command).toEqual([
			"npm",
			"install",
			"--global",
			"harnez@0.2.0",
		]);
	});
});

describe("installed version", () => {
	test("drops the platform suffix from the vendored manifest", () => {
		const directory = temporaryDirectory();
		mkdirSync(join(directory, "bin"));
		writeFileSync(
			join(directory, "package.json"),
			JSON.stringify({
				name: "harnez",
				version: `1.2.3-${process.platform}-${process.arch}`,
			}),
		);
		expect(installedVersion(join(directory, "bin", "harnez"))).toBe("1.2.3");
	});

	test("returns undefined when the layout is not a published install", () => {
		const directory = temporaryDirectory();
		mkdirSync(join(directory, "bin"));
		expect(installedVersion(join(directory, "bin", "harnez"))).toBeUndefined();
	});
});

describe("update check", () => {
	test("caches the registry answer and honors the opt-out", async () => {
		const registry = fakeRegistry("9.9.9");
		setEnvironment("HARNEZ_DATA_DIR", temporaryDirectory());
		setEnvironment("HARNEZ_REGISTRY", registry.url.toString());
		setEnvironment("HARNEZ_DISABLE_UPDATE_CHECK", undefined);
		try {
			expect(await checkLatestVersion()).toBe("9.9.9");
		} finally {
			registry.stop(true);
		}
		/** The registry is gone, so a second answer can only come from the cache. */
		expect(await checkLatestVersion()).toBe("9.9.9");
		setEnvironment("HARNEZ_DISABLE_UPDATE_CHECK", "1");
		expect(await checkLatestVersion()).toBeUndefined();
	});

	test("treats an unreachable registry as no news", async () => {
		setEnvironment("HARNEZ_DATA_DIR", temporaryDirectory());
		setEnvironment("HARNEZ_REGISTRY", "http://127.0.0.1:9");
		setEnvironment("HARNEZ_DISABLE_UPDATE_CHECK", undefined);
		expect(await checkLatestVersion()).toBeUndefined();
	});

	test("names both versions and the command that updates them", async () => {
		const registry = fakeRegistry("9.9.9");
		setEnvironment("HARNEZ_DATA_DIR", temporaryDirectory());
		setEnvironment("HARNEZ_REGISTRY", registry.url.toString());
		setEnvironment("HARNEZ_DISABLE_UPDATE_CHECK", undefined);
		/** Points the health probe at a closed port so no local server is consulted. */
		setEnvironment("HARNEZ_PORT", "9");
		setEnvironment("HARNEZ_URL", undefined);
		try {
			const notice = await updateNotice();
			expect(notice?.full).toContain("9.9.9");
			expect(notice?.full).toContain("harnez update");
			/** The short form has to stay short enough to be worth falling back to. */
			expect(notice?.short).toContain("9.9.9");
			expect(notice?.short.length).toBeLessThan(notice?.full.length ?? 0);
		} finally {
			registry.stop(true);
		}
	});

	test("stays quiet when the installed release is the latest", async () => {
		const { VERSION } = await import("../../shared/src/version");
		const registry = fakeRegistry(VERSION);
		setEnvironment("HARNEZ_DATA_DIR", temporaryDirectory());
		setEnvironment("HARNEZ_REGISTRY", registry.url.toString());
		setEnvironment("HARNEZ_DISABLE_UPDATE_CHECK", undefined);
		setEnvironment("HARNEZ_PORT", "9");
		setEnvironment("HARNEZ_URL", undefined);
		try {
			expect(await updateNotice()).toBeUndefined();
		} finally {
			registry.stop(true);
		}
	});
});
