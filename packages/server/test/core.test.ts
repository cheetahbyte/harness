import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarnessServer } from "../src/server";
import { SessionStore } from "../src/session-store";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
function harness() { const dir = mkdtempSync(join(tmpdir(), "harness-test-")); paths.push(dir); return { dir, server: new HarnessServer(new SessionStore(join(dir, "state.sqlite")), dir) }; }

describe("first milestone", () => {
  test("executes and persists a core read tool", async () => {
    const { dir, server } = harness(); writeFileSync(join(dir, "note.txt"), "hello");
    const id = server.createSession(); await server.command(id, { type: "prompt", text: "/read note.txt" });
    const events = server.store.events(id);
    expect(events.some(event => event.type === "tool-result" && event.output === "hello")).toBe(true);
    expect(new HarnessServer(new SessionStore(join(dir, "state.sqlite")), dir).store.events(id)).toEqual(events);
  });

  test("rejects tool paths outside the workspace", async () => {
    const { server } = harness(); const id = server.createSession();
    await server.command(id, { type: "prompt", text: "/read ../secret" });
    expect(server.store.events(id).some(event => event.type === "tool-result" && event.isError && event.output.includes("escapes workspace"))).toBe(true);
  });

  test("queues a follow-up after completion", async () => {
    const { server } = harness(); const id = server.createSession();
    await server.command(id, { type: "follow-up", text: "afterwards" });
    await server.command(id, { type: "prompt", text: "first" });
    expect(server.store.events(id).filter(event => event.type === "assistant-delta")).toHaveLength(2);
  });

  test("restarts with steering after aborting foreground work", async () => {
    const { server } = harness(); const id = server.createSession();
    const running = server.command(id, { type: "prompt", text: "/bash\nsleep 1" });
    await new Promise(resolve => setTimeout(resolve, 20));
    await server.command(id, { type: "steer", text: "new direction" });
    await running;
    expect(server.store.events(id).some(event => event.type === "assistant-delta" && event.text.includes("ready"))).toBe(true);
  });
});
