import { createInterface } from "node:readline";
import type { ClientCommand, ServerEvent } from "../../shared/src/protocol";

const base = process.env.HARNESS_URL ?? "http://localhost:7432";
const resume = process.argv[2];
const sessionId = resume ?? (await (await fetch(`${base}/sessions`, { method: "POST" })).json() as { sessionId: string }).sessionId;
console.log(`session ${sessionId}`);

const events = await fetch(`${base}/sessions/${sessionId}/events`);
if (!events.body) throw new Error("event stream unavailable");
(async () => { const reader = events.body!.getReader(); const decoder = new TextDecoder(); let pending = ""; for (;;) { const next = await reader.read(); if (next.done) break; pending += decoder.decode(next.value, { stream: true }); const lines = pending.split("\n"); pending = lines.pop() ?? ""; for (const line of lines) if (line) render(JSON.parse(line)); } })();

const input = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });
input.prompt();
input.on("line", async line => { await send({ type: "steer", text: line }); input.prompt(); });
process.stdin.setRawMode?.(true);
process.stdin.on("data", async key => {
  if (typeof key === "string") return;
  if (key.equals(Buffer.from("\u001b"))) await send({ type: "abort" });
  // Most terminals emit ESC+Enter for Option+Enter; map the common sequence to a queued task.
  if (key.equals(Buffer.from("\u001b\r"))) { input.question("follow-up> ", async text => { await send({ type: "follow-up", text }); input.prompt(); }); }
});

async function send(command: ClientCommand) { await fetch(`${base}/sessions/${sessionId}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) }); }
function render(event: ServerEvent) { if (event.type === "assistant-delta") process.stdout.write(event.text + "\n"); else if (event.type === "tool-call") console.log(`→ ${event.name}`); else if (event.type === "tool-result") console.log(`${event.isError ? "!" : "←"} ${event.output}`); else if (event.type === "status") console.log(`[status] ${event.text}`); else if (event.type === "error") console.log(`[error] ${event.message}`); }
