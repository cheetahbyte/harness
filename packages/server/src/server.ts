import { resolve } from "node:path";
import type { ClientCommand, ServerEvent } from "../../shared/src/protocol";
import { HarnessAgentRuntime } from "./agent-runtime";
import { SessionStore } from "./session-store";
import { CoreTools } from "./tools";
import { JsonCredentialStore, type HarnessModelConfig } from "./provider";

type Session = { listeners: Set<(event: ServerEvent) => void>; running?: AbortController; followUps: string[]; pendingSteer?: string };

export class HarnessServer {
  private readonly sessions = new Map<string, Session>();
  private readonly runtime: HarnessAgentRuntime;

  constructor(readonly store = new SessionStore(), workspace = process.cwd()) {
    this.runtime = new HarnessAgentRuntime(new CoreTools(resolve(workspace)), new JsonCredentialStore(resolve(workspace, ".harness/auth.json")));
  }

  createSession(): string { const id = this.store.create(); this.sessions.set(id, { listeners: new Set(), followUps: [] }); return id; }

  subscribe(id: string, listener: (event: ServerEvent) => void): () => void {
    const session = this.session(id);
    session.listeners.add(listener);
    for (const event of this.store.events(id)) listener(event);
    return () => session.listeners.delete(listener);
  }

  async command(id: string, command: ClientCommand): Promise<void> {
    const session = this.session(id);
    if (command.type === "abort") { session.running?.abort(); return; }
    if (command.type === "configure") { if (session.running) throw new Error("cannot change model while running"); const config: HarnessModelConfig = { provider: command.provider, model: command.model, baseUrl: command.baseUrl }; this.store.setModelConfig(id, config); this.runtime.forget(id); this.emit(id, { type: "status", text: `configured ${command.provider}/${command.model}` }); return; }
    if (command.type === "follow-up") { session.followUps.push(command.text); this.emit(id, { type: "status", text: "follow-up queued" }); return; }
    if (command.type === "steer" && session.running) { session.pendingSteer = command.text; session.running.abort(); this.emit(id, { type: "status", text: "steering after current cancellation" }); return; }
    await this.run(id, command.text);
  }

  private async run(id: string, text: string): Promise<void> {
    const session = this.session(id);
    if (session.running) return; // The steering command has aborted it; its caller owns the next run.
    const controller = new AbortController();
    session.running = controller;
    this.emit(id, { type: "status", text: "running" });
    try { await this.runtime.run(id, text, this.store.modelConfig(id), controller.signal, event => this.emit(id, event)); }
    catch (error) { this.emit(id, { type: "error", message: error instanceof Error ? error.message : String(error) }); }
    session.running = undefined;
    if (controller.signal.aborted) {
      this.emit(id, { type: "aborted" });
      const steer = session.pendingSteer;
      session.pendingSteer = undefined;
      if (steer) await this.run(id, steer);
      return;
    }
    this.emit(id, { type: "completed" });
    const followUp = session.followUps.shift();
    if (followUp) await this.run(id, followUp);
  }

  private session(id: string): Session {
    if (!this.store.exists(id)) throw new Error("session not found");
    let session = this.sessions.get(id);
    if (!session) { session = { listeners: new Set(), followUps: [] }; this.sessions.set(id, session); }
    return session;
  }

  private emit(id: string, event: ServerEvent): void { this.store.append(id, event); for (const listener of this.session(id).listeners) listener(event); }
}

export function serveHarness(options: { port?: number; workspace?: string; databasePath?: string } = {}): ReturnType<typeof Bun.serve> {
  const harness = new HarnessServer(new SessionStore(options.databasePath), options.workspace);
  return Bun.serve({ port: options.port ?? 7432, idleTimeout: 0, async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sessions") return Response.json({ sessionId: harness.createSession() });
    const match = url.pathname.match(/^\/sessions\/([^/]+)(?:\/(events|commands))?$/);
    if (!match) return new Response("not found", { status: 404 });
    const [, id, action] = match;
    try {
      if (request.method === "GET" && action === "events") {
        const stream = new ReadableStream<Uint8Array>({ start(controller) {
          const write = (event: ServerEvent) => controller.enqueue(new TextEncoder().encode(JSON.stringify(event) + "\n"));
          write({ type: "session", sessionId: id });
          const unsubscribe = harness.subscribe(id, write);
          request.signal.addEventListener("abort", () => { unsubscribe(); controller.close(); }, { once: true });
        }});
        return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
      }
      if (request.method === "POST" && action === "commands") { await harness.command(id, await request.json() as ClientCommand); return new Response(null, { status: 202 }); }
      if (request.method === "GET" && !action) return Response.json({ sessionId: id, events: harness.store.events(id) });
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 404 }); }
    return new Response("not found", { status: 404 });
  }});
}
