import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { invokeSkills } from "../src/skills";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function skill(root: string, name: string, instructions: string) {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} instructions\n---\n${instructions}`,
	);
}

test("invokes skills anywhere in a prompt and prefers narrower scopes", async () => {
	const project = mkdtempSync(join(tmpdir(), "harness-project-"));
	const home = mkdtempSync(join(tmpdir(), "harness-home-"));
	paths.push(project, home);
	skill(join(project, ".harness/skills"), "review", "project native");
	skill(join(project, ".agents/skills"), "review", "project shared");
	skill(join(home, ".harness/skills"), "review", "user native");
	skill(join(home, ".agents/skills"), "review", "user shared");

	const prompt = await invokeSkills(
		project,
		"Please /review this twice: /review and keep /unknown.",
		home,
	);

	expect(prompt).toContain("project native");
	expect(prompt).not.toContain("project shared");
	expect(prompt).not.toContain("user native");
	expect(prompt).not.toContain("user shared");
	expect(prompt.match(/<skill name="review"/g)).toHaveLength(1);
	expect(prompt).toContain("Please");
	expect(prompt).toContain("keep /unknown.");
});
