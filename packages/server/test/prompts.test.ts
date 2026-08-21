import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SYSTEM_PROMPT } from "../src/agent/runtime";
import { contextCapabilities } from "../src/agent/tools";
import { PRESSURE_NOTE } from "../src/context/manager";
import { expandPrompt, scanPrompts } from "../src/prompts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

test("guides agents to avoid short-task bookkeeping and batch tool calls", () => {
	const capabilities = contextCapabilities("binding");
	const episode = capabilities.find((item) => item.name === "episode");
	const pin = capabilities.find((item) => item.name === "pin_context");

	expect(SYSTEM_PROMPT).toContain("Batch independent tool calls");
	/**
	 * Catalog tools are invisible until loaded, so a model that trusts its tool
	 * list will deny capabilities the user has actually connected, or reach for
	 * bash instead of the tool built for the job.
	 */
	expect(SYSTEM_PROMPT).toContain("Your tool list is partial");
	expect(SYSTEM_PROMPT).toContain("call capabilities_search");
	expect(SYSTEM_PROMPT).toContain(
		"Never conclude that a tool is unavailable from your tool list alone",
	);
	expect(SYSTEM_PROMPT).toContain("skip episodes and pin_context for short tasks");
	/** The trigger has to be something the model can observe, not a guess. */
	expect(SYSTEM_PROMPT).toContain(
		"once context is reported to be under compaction pressure",
	);
	expect(PRESSURE_NOTE).toContain("under compaction pressure");
	/** Placeholders are recoverable, and nothing else says so to the model. */
	expect(SYSTEM_PROMPT).toContain(
		"read it back with recall_observation instead of running the tool again",
	);
	expect(pin?.description).toContain("Skip it for short tasks");
	expect(episode?.description).toContain(
		"Exploration end requires a conclusion; action end must omit it",
	);
	expect(JSON.stringify(episode?.schema)).toContain(
		"Required when ending exploration; omit when ending action",
	);
});

function workspaces() {
	const project = mkdtempSync(join(tmpdir(), "harnez-project-"));
	const home = mkdtempSync(join(tmpdir(), "harnez-home-"));
	paths.push(project, home);
	return { project, home };
}

function prompt(root: string, file: string, contents: string) {
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, file), contents);
}

test("reads templates with and without frontmatter", async () => {
	const { project, home } = workspaces();
	prompt(
		join(project, ".harnez/prompts"),
		"review-pr.md",
		"---\ndescription: Review an open pull request\n---\nRead the diff and report defects.",
	);
	prompt(
		join(project, ".harnez/prompts"),
		"standup.md",
		"# Daily standup\n\nSummarize yesterday's commits.",
	);
	prompt(
		join(project, ".harnez/prompts"),
		"renamed.md",
		"---\nname: release-notes\n---\nDraft release notes.",
	);

	const { templates, diagnostics } = await scanPrompts(project, home);

	expect(diagnostics).toEqual([]);
	expect(
		templates.map(({ name, description }) => ({ name, description })),
	).toEqual([
		{ name: "release-notes", description: "Draft release notes." },
		{ name: "review-pr", description: "Review an open pull request" },
		{ name: "standup", description: "Daily standup" },
	]);
	expect(templates[2]?.body).toBe(
		"# Daily standup\n\nSummarize yesterday's commits.",
	);
});

test("prefers the first root that defines a name", async () => {
	const { project, home } = workspaces();
	prompt(join(project, ".harnez/prompts"), "review.md", "Project review.");
	prompt(join(project, ".agents/prompts"), "review.md", "Shared review.");
	prompt(join(home, ".config/harnez/prompts"), "review.md", "User review.");
	prompt(join(home, ".agents/prompts"), "plan.md", "User plan.");

	const { templates } = await scanPrompts(project, home);

	expect(templates.map(({ name }) => name)).toEqual(["plan", "review"]);
	expect(templates[1]?.body).toBe("Project review.");
});

test("reports invalid templates instead of exposing them", async () => {
	const { project, home } = workspaces();
	prompt(join(project, ".harnez/prompts"), "Review PR.md", "Mixed case name.");
	prompt(
		join(project, ".harnez/prompts"),
		"empty.md",
		"---\ndescription: Nothing follows\n---\n\n",
	);
	prompt(
		join(project, ".harnez/prompts"),
		"broken.md",
		"---\ndescription: []\n---\nBroken description.",
	);
	prompt(join(project, ".harnez/prompts"), "notes.txt", "Not a template.");
	prompt(join(project, ".harnez/prompts"), "valid.md", "Valid template.");

	const { templates, diagnostics } = await scanPrompts(project, home);

	expect(templates.map(({ name }) => name)).toEqual(["valid"]);
	expect(diagnostics.map(({ path }) => path.split("/").at(-1))).toEqual([
		"broken.md",
		"empty.md",
		"Review PR.md",
	]);
	expect(diagnostics.every(({ state }) => state === "invalid")).toBe(true);
});

test("reports unreadable roots and keeps scanning the rest", async () => {
	const { project, home } = workspaces();
	mkdirSync(join(project, ".harnez"), { recursive: true });
	writeFileSync(join(project, ".harnez/prompts"), "not a directory");
	prompt(join(home, ".config/harnez/prompts"), "plan.md", "User plan.");

	const { templates, diagnostics } = await scanPrompts(project, home);

	expect(templates.map(({ name }) => name)).toEqual(["plan"]);
	expect(diagnostics.map(({ path, state }) => ({ path, state }))).toEqual([
		{ path: join(project, ".harnez/prompts"), state: "unreadable" },
	]);
});

test("expands only a leading invocation and appends trailing text", async () => {
	const { project, home } = workspaces();
	prompt(
		join(project, ".harnez/prompts"),
		"review-pr.md",
		"Read the diff and report defects.",
	);
	const { templates } = await scanPrompts(project, home);

	expect(expandPrompt("/review-pr", templates).text).toBe(
		"Read the diff and report defects.",
	);
	expect(expandPrompt("  /review-pr  #42  ", templates).text).toBe(
		"Read the diff and report defects.\n\n#42",
	);
	expect(expandPrompt("/review-pr", templates).template?.name).toBe(
		"review-pr",
	);
	for (const text of ["please /review-pr", "/unknown 42", "review-pr"])
		expect(expandPrompt(text, templates)).toEqual({ text });
});

test("still reads project templates from the pre-rename .harness directory", async () => {
	const { project, home } = workspaces();
	prompt(join(project, ".harness/prompts"), "legacy.md", "Legacy template.");
	prompt(
		join(home, ".config/harnez/prompts"),
		"user.md",
		"User template.",
	);

	const { templates } = await scanPrompts(project, home);

	expect(templates.map((template) => template.name)).toEqual([
		"legacy",
		"user",
	]);
});

test("prefers .harnez over .harness for the same template name", async () => {
	const { project, home } = workspaces();
	prompt(join(project, ".harnez/prompts"), "review.md", "Current.");
	prompt(join(project, ".harness/prompts"), "review.md", "Legacy.");

	const { templates } = await scanPrompts(project, home);

	expect(templates).toHaveLength(1);
	expect(templates[0]?.body).toBe("Current.");
});
