import { Type } from "@earendil-works/pi-ai";

import { sanitizedChildEnvironment } from "../telemetry/runtime";
import { EvictionPriority, WorkspaceTool } from "./tool";

export class BashTool extends WorkspaceTool {
	readonly name = "bash";
	override readonly evictionPriority = EvictionPriority.Late;
	readonly description = "Run a shell command in the workspace.";
	readonly schema = Type.Object({ command: Type.String({ minLength: 1 }) });

	private lastCommand: string | undefined;
	private consecutiveCount = 0;
	private sleepCount = 0;

	async execute(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string> {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		if (typeof input["command"] !== "string" || !input["command"])
			throw new Error("command must be a non-empty string");
		const command = input["command"];
		if (command === this.lastCommand) {
			this.consecutiveCount++;
		} else {
			this.lastCommand = command;
			this.consecutiveCount = 1;
		}
		if (/\bsleep\b/.test(command)) {
			this.sleepCount++;
		}
		const proc = Bun.spawn(["/bin/sh", "-lc", command], {
			cwd: this.workspace,
			env: sanitizedChildEnvironment(),
			stdout: "pipe",
			stderr: "pipe",
		});
		const abort = () => proc.kill();
		signal.addEventListener("abort", abort, { once: true });
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		signal.removeEventListener("abort", abort);
		let output = (stdout + stderr).slice(0, 64_000);
		if (exitCode !== 0) throw new Error(`exit ${exitCode}: ${output}`);
		output = output || "completed";
		if (this.consecutiveCount >= 3 || this.sleepCount >= 4) {
			output +=
				"\n\n[advisory: repeated identical command; change approach, block on get_agent_result, or condense_context]";
		}
		return output;
	}
}
