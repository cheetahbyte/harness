import { ensureServer, runServerCommand } from "./server-command";

const USAGE =
	"Usage: harnez [--resume [session-id]] | harnez server <start|status|stop|run>";

export function parseResume(args: string[]): string | true | undefined {
	if (args.length === 0) return undefined;
	if (args.length === 1 && args[0] === "--resume") return true;
	if (args.length === 2 && args[0] === "--resume" && args[1]) return args[1];
	throw new Error(USAGE);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === "server") await runServerCommand(args.slice(1));
	else {
		const resume = parseResume(args);
		await ensureServer();
		const { runTui } = await import("../../tui/src/index");
		await runTui(
			resume === true
				? { pickSession: true }
				: resume === undefined
					? {}
					: { sessionId: resume },
		);
	}
}

if (import.meta.main)
	await main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(
			error instanceof Error && error.message.startsWith("Usage:") ? 2 : 1,
		);
	});
