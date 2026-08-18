import { Type } from "@earendil-works/pi-ai";

import { sanitizedChildEnvironment } from "../telemetry/runtime";
import { EvictionPriority, WorkspaceTool } from "./tool";

export class BashTool extends WorkspaceTool {
	readonly name = "bash";
	override readonly evictionPriority = EvictionPriority.Late;
	readonly description = "Run a shell command in the workspace.";
	readonly schema = Type.Object({ command: Type.String({ minLength: 1 }) });

	async execute(
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<string> {
		if (signal.aborted) throw new DOMException("Aborted", "AbortError");
		if (typeof input["command"] !== "string" || !input["command"])
			throw new Error("command must be a non-empty string");
		const proc = Bun.spawn(["/bin/sh", "-lc", input["command"]], {
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
		const output = (stdout + stderr).slice(0, 64_000);
		if (exitCode !== 0) throw new Error(`exit ${exitCode}: ${output}`);
		return output || "completed";
	}
}
