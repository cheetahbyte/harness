import { afterEach, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CapabilityCatalog,
	CapabilityContext,
} from "../src/capability-control";
import { activateSkill, invokeSkills, scanSkills } from "../src/skills";

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

test("discovers only explicit model-invocable manifests", async () => {
	const project = mkdtempSync(join(tmpdir(), "harness-project-"));
	const home = mkdtempSync(join(tmpdir(), "harness-home-"));
	paths.push(project, home);
	const root = join(project, ".harness/skills");
	skill(
		root,
		"review",
		"--- marker in body is harmless",
	);
	writeFileSync(
		join(root, "review/SKILL.md"),
		"---\nid: review\ndescription: Review changes\nmodelInvocable: true\ntags: [git, review]\n---\nReview carefully.",
	);
	skill(root, "legacy", "legacy body");
	mkdirSync(join(root, "operator"), { recursive: true });
	writeFileSync(
		join(root, "operator/SKILL.md"),
		"---\nid: operator\ndescription: Operator only\nmodelInvocable: false\n---\nOperator instructions.",
	);

	const scanned = await scanSkills(project, home, "catalog-1");

	expect(scanned.discoverable.map((entry) => entry.ref.id)).toEqual([
		"skill:review",
	]);
	expect(scanned.operatorOnly.map((entry) => entry.ref.id)).toEqual([
		"skill:operator",
	]);
	expect(scanned.diagnostics.some(({ path }) => path.includes("legacy"))).toBe(
		true,
	);
});

test("activates from one verified buffer and rejects edited skills", async () => {
	const project = mkdtempSync(join(tmpdir(), "harness-project-"));
	const home = mkdtempSync(join(tmpdir(), "harness-home-"));
	paths.push(project, home);
	const root = join(project, ".harness/skills/review");
	mkdirSync(root, { recursive: true });
	const path = join(root, "SKILL.md");
	writeFileSync(
		path,
		"---\nid: review\ndescription: Review changes\nmodelInvocable: true\n---\nReview carefully.",
	);
	const scanned = await scanSkills(project, home, "catalog-1");
	const entry = scanned.discoverable[0];
	if (!entry) throw new Error("missing scanned skill");
	const snapshot = new CapabilityCatalog(
		[entry.capability],
		"catalog-1",
	).snapshot({
		tool: { maxLevel: "none", confirmation: "none" },
		skill: { maxLevel: "activate" },
	});
	const capability = snapshot.list().items[0]?.ref;
	if (!capability) throw new Error("missing capability ref");
	const context = new CapabilityContext(
		{},
		(_base, items) => items,
		8_000,
		10,
	);
	const accountant = {
		modelId: "test",
		serializerVersion: "json-v1",
		method: "conservative_estimate" as const,
		count: (value: unknown) => JSON.stringify(value).length,
	};
	expect(
		(await activateSkill(entry, capability, context, accountant)).status,
	).toBe("admitted");
	expect(context.items()[0]?.content).toBe("Review carefully.");

	writeFileSync(path, `${readText(path)}\nChanged.`);
	await expect(
		activateSkill(entry, capability, context, accountant),
	).rejects.toThrow("STALE_CAPABILITY");
});

function readText(path: string): string {
	return readFileSync(path, "utf8");
}
