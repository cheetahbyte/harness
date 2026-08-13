import { VERSION } from "../../shared/src/version";
import { ensureServer, runServerCommand } from "./server-command";
import { runUpdateCommand } from "./update";
import { updateNotice } from "./update-check";

const USAGE =
	"Usage: harnez [--resume [session-id]] | harnez server <start|status|stop|restart|run> | harnez update | harnez --version";

export function parseResume(args: string[]): string | true | undefined {
	if (args.length === 0) return undefined;
	if (args.length === 1 && args[0] === "--resume") return true;
	if (args.length === 2 && args[0] === "--resume" && args[1]) return args[1];
	throw new Error(USAGE);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === "--version" || args[0] === "-v") {
		if (args.length !== 1) throw new Error(USAGE);
		console.log(VERSION);
		return;
	}
	if (args[0] === "server") await runServerCommand(args.slice(1));
	else if (args[0] === "update") {
		if (args.length !== 1) throw new Error(USAGE);
		await runUpdateCommand();
	} else {
		const resume = parseResume(args);
		/**
		 * Started before the server so the round trip overlaps startup, and passed
		 * in unawaited so a slow or unreachable registry never delays the TUI.
		 */
		const notice = updateNotice().catch(() => undefined);
		await ensureServer();
		const { runTui } = await import("../../tui/src/index");
		await runTui({
			notice,
			...(resume === true
				? { pickSession: true }
				: resume === undefined
					? {}
					: { sessionId: resume }),
		});
	}
}

if (import.meta.main)
	await main().catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(
			error instanceof Error && error.message.startsWith("Usage:") ? 2 : 1,
		);
	});
