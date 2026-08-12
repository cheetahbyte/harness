import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expandPrompt, scanPrompts } from "../src/prompts";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0))
		rmSync(path, { recursive: true, force: true });
});

function workspaces() {
	const project = mkdtempSync(join(tmpdir(), "harness-project-"));
	const home = mkdtempSync(join(tmpdir(), "harness-home-"));
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
		join(project, ".harness/prompts"),
		"review-pr.md",
		"---\ndescription: Review an open pull request\n---\nRead the diff and report defects.",
	);
	prompt(
		join(project, ".harness/prompts"),
		"standup.md",
		"# Daily standup\n\nSummarize yesterday's commits.",
	);
	prompt(
		join(project, ".harness/prompts"),
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
	prompt(join(project, ".harness/prompts"), "review.md", "Project review.");
	prompt(join(project, ".agents/prompts"), "review.md", "Shared review.");
	prompt(join(home, ".harness/prompts"), "review.md", "User review.");
	prompt(join(home, ".agents/prompts"), "plan.md", "User plan.");

	const { templates } = await scanPrompts(project, home);

	expect(templates.map(({ name }) => name)).toEqual(["plan", "review"]);
	expect(templates[1]?.body).toBe("Project review.");
});

test("reports invalid templates instead of exposing them", async () => {
	const { project, home } = workspaces();
	prompt(join(project, ".harness/prompts"), "Review PR.md", "Mixed case name.");
	prompt(
		join(project, ".harness/prompts"),
		"empty.md",
		"---\ndescription: Nothing follows\n---\n\n",
	);
	prompt(
		join(project, ".harness/prompts"),
		"broken.md",
		"---\ndescription: []\n---\nBroken description.",
	);
	prompt(join(project, ".harness/prompts"), "notes.txt", "Not a template.");
	prompt(join(project, ".harness/prompts"), "valid.md", "Valid template.");

	const { templates, diagnostics } = await scanPrompts(project, home);

	expect(templates.map(({ name }) => name)).toEqual(["valid"]);
	expect(diagnostics.map(({ path }) => path.split("/").at(-1))).toEqual([
		"broken.md",
		"empty.md",
		"Review PR.md",
	]);
	expect(diagnostics.every(({ state }) => state === "invalid")).toBe(true);
});

test("expands only a leading invocation and appends trailing text", async () => {
	const { project, home } = workspaces();
	prompt(
		join(project, ".harness/prompts"),
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
