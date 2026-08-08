import type { Model } from "@earendil-works/pi-ai";
import type { Agent } from "@mariozechner/pi-agent-core";
import type { ServerEvent } from "../../shared/src/protocol";
import type { CoreTools, ToolRequest } from "./tools";

/** The only model boundary used by Harness. Pi types do not escape this file. */
export interface AgentRuntime {
  run(text: string, signal: AbortSignal, emit: (event: ServerEvent) => void): Promise<void>;
}

type PiRuntimeDependencies = { model?: Model<any>; agent?: Agent };

/**
 * Minimal adapter until provider/auth configuration is designed. `Model` and `Agent`
 * stay here so swapping this command adapter for the Pi loop changes no server code.
 */
export class HarnessAgentRuntime implements AgentRuntime {
  constructor(private readonly tools: CoreTools, private readonly pi: PiRuntimeDependencies = {}) {}

  async run(text: string, signal: AbortSignal, emit: (event: ServerEvent) => void): Promise<void> {
    void this.pi; // Reserved narrow seam: Pi provider setup is not specified by the architecture.
    const request = parseTool(text);
    if (!request) { emit({ type: "assistant-delta", text: "Harness is ready. Use /read, /write, /edit, or /bash while model provider setup is pending." }); return; }
    const id = crypto.randomUUID();
    emit({ type: "tool-call", id, name: request.name, input: request.input });
    try { emit({ type: "tool-result", id, name: request.name, output: await this.tools.execute(request, signal) }); }
    catch (error) { emit({ type: "tool-result", id, name: request.name, output: error instanceof Error ? error.message : String(error), isError: true }); }
  }
}

function parseTool(text: string): ToolRequest | undefined {
  const [head, ...body] = text.split("\n");
  const [command, path] = head.trim().split(/\s+/, 2);
  if (command === "/read" && path) return { name: "read", input: { path } };
  if (command === "/bash") return { name: "bash", input: { command: text.slice(head.length).trim() } };
  if (command === "/write" && path) return { name: "write", input: { path, content: body.join("\n") } };
  if (command === "/edit" && path) {
    const divider = body.indexOf("---");
    if (divider >= 0) return { name: "edit", input: { path, oldText: body.slice(0, divider).join("\n"), newText: body.slice(divider + 1).join("\n") } };
  }
}
