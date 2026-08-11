#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const { dirname, join } = require("node:path");

const requireFromHere = createRequire(__filename);
const packages = {
	"darwin-arm64": "harnez-darwin-arm64",
	"darwin-x64": "harnez-darwin-x64",
	"linux-x64": "harnez-linux-x64",
};

function binaryPath() {
	if (process.env.HARNEZ_BINARY) return process.env.HARNEZ_BINARY;
	const target = `${process.platform}-${process.arch}`;
	const packageName = packages[target];
	if (!packageName)
		throw new Error(
			`harnez does not support ${process.platform}/${process.arch}`,
		);
	try {
		return join(
			dirname(requireFromHere.resolve(`${packageName}/package.json`)),
			"bin",
			"harnez",
		);
	} catch {
		throw new Error(
			`missing ${packageName}; reinstall harnez without --omit=optional`,
		);
	}
}

async function main() {
	const child = spawn(binaryPath(), process.argv.slice(2), {
		stdio: "inherit",
	});
	const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
	const forwards = new Map(
		signals.map((signal) => [
			signal,
			() => {
				if (child.killed) return;
				try {
					child.kill(signal);
				} catch {}
			},
		]),
	);
	const cleanup = () => {
		for (const [signal, forward] of forwards) process.off(signal, forward);
	};
	for (const [signal, forward] of forwards) process.on(signal, forward);

	await new Promise((resolve, reject) => {
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("exit", (code, signal) => {
			cleanup();
			if (signal) process.kill(process.pid, signal);
			else {
				process.exitCode = code ?? 1;
				resolve();
			}
		});
	});
}

main().catch((error) => {
	console.error(`harnez: ${error.message}`);
	process.exitCode = 1;
});
