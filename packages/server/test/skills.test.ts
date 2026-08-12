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
import { CapabilityCatalog } from "../src/capabilities/catalog";
import { CapabilityContext } from "../src/capabilities/context";
import { activateSkill, scanSkills } from "../src/skills";

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

test("accepts name or id and honors disable-model-invocation", async () => {
	const project = mkdtempSync(join(tmpdir(), "harnez-project-"));
	const home = mkdtempSync(join(tmpdir(), "harnez-home-"));
	paths.push(project, home);
	const root = join(project, ".harnez/skills");
	skill(root, "review", "--- marker in body is harmless");
	mkdirSync(join(root, "id-only"), { recursive: true });
	writeFileSync(
		join(root, "id-only/SKILL.md"),
		"---\nid: id-only\ndescription: Uses the id field\n---\nID instructions.",
	);
	mkdirSync(join(root, "operator"), { recursive: true });
	writeFileSync(
		join(root, "operator/SKILL.md"),
		"---\nname: operator\ndescription: >\n  Operator only\n  instructions\ndisable-model-invocation: true\n---\nOperator instructions.",
	);
	mkdirSync(join(root, "invalid"), { recursive: true });
	writeFileSync(
		join(root, "invalid/SKILL.md"),
		"---\nid: one\nname: two\ndescription: Conflicting names\n---\nInvalid.",
	);

	const scanned = await scanSkills(project, home, "catalog-1");

	expect(scanned.discoverable.map((entry) => entry.ref.id)).toEqual([
		"skill:id-only",
		"skill:review",
	]);
	expect(scanned.operatorOnly.map((entry) => entry.ref.id)).toEqual([
		"skill:operator",
	]);
	expect(scanned.diagnostics.some(({ path }) => path.includes("invalid"))).toBe(
		true,
	);
});

test("activates from one verified buffer and rejects edited skills", async () => {
	const project = mkdtempSync(join(tmpdir(), "harnez-project-"));
	const home = mkdtempSync(join(tmpdir(), "harnez-home-"));
	paths.push(project, home);
	const root = join(project, ".harnez/skills/review");
	mkdirSync(root, { recursive: true });
	const path = join(root, "SKILL.md");
	writeFileSync(
		path,
		"---\nname: review\ndescription: Review changes\n---\nReview carefully.",
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
