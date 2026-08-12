import { closeSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runServer } from "../../server/src/index";

export type Health = { name: "harnez"; pid: number };

const SERVER_USAGE = "Usage: harnez server <start|status|stop|run>";

function serverUrl(): string {
	return (
		process.env["HARNEZ_URL"] ??
		process.env["HARNESS_URL"] ??
		`http://127.0.0.1:${process.env["HARNEZ_PORT"] ?? process.env["HARNESS_PORT"] ?? "7432"}`
	);
}

export async function health(base = serverUrl()): Promise<Health | undefined> {
	let response: Response;
	try {
		response = await fetch(new URL("/health", base), {
			signal: AbortSignal.timeout(750),
		});
	} catch {
		return undefined;
	}
	const body = (await response.json().catch(() => undefined)) as
		| { name?: unknown; pid?: unknown }
		| undefined;
	if (
		!response.ok ||
		body?.name !== "harnez" ||
		!Number.isInteger(body.pid) ||
		Number(body.pid) <= 0
	)
		throw new Error(`${base} is responding, but it is not Harnez`);
	return { name: "harnez", pid: Number(body.pid) };
}

export async function ensureServer(): Promise<void> {
	if (await health()) return;
	if (process.env["HARNEZ_URL"] ?? process.env["HARNESS_URL"])
		throw new Error(
			`configured Harnez server is unavailable at ${serverUrl()}`,
		);

	const directory = dataDirectory();
	mkdirSync(directory, { recursive: true });
	const logPath = join(directory, "server.log");
	const log = openSync(logPath, "a");
	try {
		const child = Bun.spawn([...selfCommand(), "server", "run"], {
			detached: true,
			stdin: "ignore",
			stdout: log,
			stderr: log,
			env: {
				...process.env,
				HARNEZ_DATABASE_PATH:
					process.env["HARNEZ_DATABASE_PATH"] ??
					join(directory, "harnez.sqlite"),
			},
		});
		child.unref();
	} finally {
		closeSync(log);
	}

	if (await waitForHealth(true)) return;
	throw new Error(`Harnez server did not start; see ${logPath}`);
}

export async function runServerCommand(args: string[]): Promise<void> {
	if (args.length !== 1) throw new Error(SERVER_USAGE);
	switch (args[0]) {
		case "start": {
			await ensureServer();
			const running = await health();
			if (!running) throw new Error("Harnez server exited during startup");
			console.log(`Harnez server running (pid ${running.pid})`);
			return;
		}
		case "status": {
			const running = await health();
			console.log(
				running
					? `Harnez server running (pid ${running.pid})`
					: "Harnez server stopped",
			);
			return;
		}
		case "stop": {
			const hostname = new URL(serverUrl()).hostname;
			if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname))
				throw new Error("Harnez can only stop a local server");
			const running = await health();
			if (!running) {
				console.log("Harnez server already stopped");
				return;
			}
			process.kill(running.pid, "SIGTERM");
			if (await waitForHealth(false)) {
				console.log("Harnez server stopped");
				return;
			}
			throw new Error(`Harnez server ${running.pid} did not stop`);
		}
		case "run":
			process.env["HARNEZ_DATABASE_PATH"] ??= join(
				dataDirectory(),
				"harnez.sqlite",
			);
			runServer();
			return;
		default:
			throw new Error(SERVER_USAGE);
	}
}

async function waitForHealth(running: boolean): Promise<boolean> {
	for (let attempt = 0; attempt < 100; attempt++) {
		await Bun.sleep(50);
		if (Boolean(await health()) === running) return true;
	}
	return false;
}

function selfCommand(): string[] {
	const entry = process.argv[1];
	return entry?.startsWith("/$bunfs/")
		? [process.execPath]
		: [process.execPath, entry ?? "packages/cli/src/index.ts"];
}

function dataDirectory(): string {
	if (process.env["HARNEZ_DATA_DIR"]) return process.env["HARNEZ_DATA_DIR"];
	if (process.platform === "darwin")
		return join(homedir(), "Library", "Application Support", "harnez");
	if (process.platform === "win32")
		return join(
			process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"),
			"harnez",
		);
	return join(
		process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"),
		"harnez",
	);
}
