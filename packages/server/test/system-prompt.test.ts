import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SYSTEM_PROMPT, resolveSystemPrompt } from "../src/system-prompt";
import { ContextManager } from "../src/context/manager";
import { ensureSystem } from "../src/agent/events";
import { SessionStore } from "../src/sessions/store";
import { tokenCost } from "../src/token-cost";

const roots: string[] = [];
const originalConfigHome = process.env["XDG_CONFIG_HOME"];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	if (originalConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
	else process.env["XDG_CONFIG_HOME"] = originalConfigHome;
});

function setup() {
	const home = mkdtempSync(join(tmpdir(), "harnez-prompt-home-"));
	const workspace = mkdtempSync(join(tmpdir(), "harnez-prompt-project-"));
	roots.push(home, workspace);
	return { home, workspace };
}

function put(path: string, body: string | Uint8Array) {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, body);
}

test("uses the built-in prompt when no files exist", () => {
	const { home, workspace } = setup();
	expect(resolveSystemPrompt(workspace, home)).toBe(SYSTEM_PROMPT);
});

test("explains authoritative source coverage", () => {
	expect(SYSTEM_PROMPT).toContain("referenced user source has the same authority");
	expect(SYSTEM_PROMPT).toContain("targeted task");
	expect(SYSTEM_PROMPT).toContain("exhaustive task");
	expect(SYSTEM_PROMPT).toContain("unread range");
});

test("replaces then appends in global/project order", () => {
	const { home, workspace } = setup();
	put(join(home, ".config/harnez/SYSTEM.md"), "  operator  \n");
	put(join(home, ".config/harnez/APPEND_SYSTEM.md"), " global ");
	put(join(workspace, ".harnez/APPEND_SYSTEM.md"), " project ");
	expect(resolveSystemPrompt(workspace, home)).toBe("operator\n\nglobal\n\nproject");
});

test("prefers new paths over legacy paths", () => {
	const { home, workspace } = setup();
	put(join(home, ".config/harness/SYSTEM.md"), "legacy");
	put(join(home, ".config/harnez/SYSTEM.md"), "new");
	put(join(workspace, ".harness/APPEND_SYSTEM.md"), "legacy project");
	put(join(workspace, ".harnez/APPEND_SYSTEM.md"), "new project");
	expect(resolveSystemPrompt(workspace, home)).toBe("new\n\nnew project");
});

test("keeps an empty override but ignores empty appends", () => {
	const { home, workspace } = setup();
	put(join(home, ".config/harnez/SYSTEM.md"), " \n\t");
	put(join(home, ".config/harnez/APPEND_SYSTEM.md"), " \n");
	put(join(workspace, ".harnez/APPEND_SYSTEM.md"), " project ");
	expect(resolveSystemPrompt(workspace, home)).toBe("project");
});

test("fails with the path for invalid UTF-8 and read errors", () => {
	const { home, workspace } = setup();
	const path = join(home, ".config/harnez/SYSTEM.md");
	put(path, new Uint8Array([0xc3, 0x28]));
	expect(() => resolveSystemPrompt(workspace, home)).toThrow(path);

	rmSync(path);
	const directory = join(home, ".config/harnez/APPEND_SYSTEM.md");
	mkdirSync(directory, { recursive: true });
	expect(() => resolveSystemPrompt(workspace, home)).toThrow(directory);
});

test("persists the first prompt and reuses it after edits and restart", () => {
	const { home, workspace } = setup();
	process.env["XDG_CONFIG_HOME"] = join(home, ".config");
	const config = join(home, ".config/harnez");
	put(join(config, "SYSTEM.md"), "first");
	const database = join(workspace, "state.sqlite");
	const store = new SessionStore(database);
	const session = store.create(workspace);
	const context = new ContextManager(store);

	expect(ensureSystem({ sessionId: session, store, context, workspace })).toBe("first");
	const item = store.contextItems(session).find(({ kind }) => kind === "system");
	expect(item?.payload).toBe("first");
	expect(item?.tokenCost).toBe(tokenCost("first", 1));
	put(join(config, "SYSTEM.md"), "second");
	expect(ensureSystem({ sessionId: session, store, context, workspace })).toBe("first");
	store.db.close();

	const reopened = new SessionStore(database);
	const reopenedContext = new ContextManager(reopened);
	expect(ensureSystem({ sessionId: session, store: reopened, context: reopenedContext, workspace })).toBe("first");
	const fresh = reopened.create(workspace);
	expect(ensureSystem({ sessionId: fresh, store: reopened, context: reopenedContext, workspace })).toBe("second");
	reopened.db.close();
});
