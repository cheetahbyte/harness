import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

export type CoreTool = "read" | "write" | "edit" | "bash";
export type ToolRequest = { name: CoreTool; input: Record<string, unknown> };

export class CoreTools {
  constructor(private readonly workspace: string) {}

  private path(value: unknown): string {
    if (typeof value !== "string" || !value) throw new Error("path must be a non-empty string");
    const absolute = resolve(this.workspace, value);
    if (relative(this.workspace, absolute).startsWith("..")) throw new Error("path escapes workspace");
    return absolute;
  }

  async execute(request: ToolRequest, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    switch (request.name) {
      case "read": return await readFile(this.path(request.input.path), "utf8");
      case "write": {
        if (typeof request.input.content !== "string") throw new Error("content must be a string");
        await writeFile(this.path(request.input.path), request.input.content);
        return `wrote ${request.input.path}`;
      }
      case "edit": {
        if (typeof request.input.oldText !== "string" || typeof request.input.newText !== "string") throw new Error("oldText and newText must be strings");
        const path = this.path(request.input.path);
        const source = await readFile(path, "utf8");
        const count = source.split(request.input.oldText).length - 1;
        if (count !== 1) throw new Error(`oldText must occur exactly once (found ${count})`);
        await writeFile(path, source.replace(request.input.oldText, request.input.newText));
        return `edited ${request.input.path}`;
      }
      case "bash": return await this.bash(request.input.command, signal);
    }
  }

  private async bash(command: unknown, signal: AbortSignal): Promise<string> {
    if (typeof command !== "string" || !command) throw new Error("command must be a non-empty string");
    const proc = Bun.spawn(["/bin/sh", "-lc", command], { cwd: this.workspace, stdout: "pipe", stderr: "pipe" });
    const abort = () => proc.kill();
    signal.addEventListener("abort", abort, { once: true });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    signal.removeEventListener("abort", abort);
    const output = (stdout + stderr).slice(0, 64_000);
    if (exitCode !== 0) throw new Error(`exit ${exitCode}: ${output}`);
    return output || "completed";
  }
}
