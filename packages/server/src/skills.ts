import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
	formatSkillInvocation,
	loadSkills,
	type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
	type CapabilityContext,
	type CapabilityRef,
	rawHash,
	type SkillCapabilityInput,
	structuredHash,
	type TokenAccountant,
} from "./capability-control";

export type SkillDiscoveryState = "discoverable" | "operator_only" | "invalid";
export type SkillRef = {
	id: string;
	catalogGeneration: string;
	manifestHash: string;
	manifestHashScheme: "jcs-sha256-v1";
	bodyHash: string;
	bodyHashScheme: "raw-sha256-v1";
};
export type SkillSnapshotEntry = {
	ref: SkillRef;
	capability: SkillCapabilityInput;
	path: string;
	discoveryState: Exclude<SkillDiscoveryState, "invalid">;
};
export type SkillDiagnostic = {
	path: string;
	state: "invalid";
	error: string;
};
export type SkillScan = {
	discoverable: SkillSnapshotEntry[];
	operatorOnly: SkillSnapshotEntry[];
	diagnostics: SkillDiagnostic[];
};

function skillRoots(workspace: string, home = homedir()): string[] {
	return [
		join(workspace, ".harness/skills"),
		join(workspace, ".agents/skills"),
		join(home, ".harness/skills"),
		join(home, ".agents/skills"),
	];
}

/** Metadata-only skill scan. Each SKILL.md is read exactly once per scan. */
export async function scanSkills(
	workspace: string,
	home = homedir(),
	catalogGeneration: string = crypto.randomUUID(),
): Promise<SkillScan> {
	const result: SkillScan = {
		discoverable: [],
		operatorOnly: [],
		diagnostics: [],
	};
	const seen = new Set<string>();
	for (const root of skillRoots(workspace, home)) {
		const directories = await readdir(root, { withFileTypes: true }).catch(
			() => [],
		);
		for (const directory of directories
			.filter((entry) => entry.isDirectory())
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(root, directory.name, "SKILL.md");
			let buffer: Buffer;
			try {
				buffer = await readFile(path);
			} catch (error) {
				result.diagnostics.push({
					path,
					state: "invalid",
					error: error instanceof Error ? error.message : String(error),
				});
				continue;
			}
			try {
				const parsed = parseSkillBuffer(buffer);
				const canonicalId = `skill:${parsed.manifest.id}`;
				if (seen.has(canonicalId)) continue;
				seen.add(canonicalId);
				const manifestHash = structuredHash(parsed.manifest);
				const bodyHash = rawHash(buffer);
				const entry: SkillSnapshotEntry = {
					ref: {
						id: canonicalId,
						catalogGeneration,
						manifestHash,
						manifestHashScheme: "jcs-sha256-v1",
						bodyHash,
						bodyHashScheme: "raw-sha256-v1",
					},
					capability: {
						kind: "skill",
						id: canonicalId,
						name: parsed.manifest.id,
						description: parsed.manifest.description,
						tags: parsed.manifest.tags,
						providerDisplayName: "Skill files",
						metadataTrust: "operator_approved",
						modelDiscoverable: parsed.manifest.modelInvocable,
						providerBinding: {
							providerId: "skill-files",
							bindingGeneration: catalogGeneration,
						},
						manifestHash,
						bodyHash,
					},
					path,
					discoveryState: parsed.manifest.modelInvocable
						? "discoverable"
						: "operator_only",
				};
				(parsed.manifest.modelInvocable
					? result.discoverable
					: result.operatorOnly
				).push(entry);
			} catch (error) {
				result.diagnostics.push({
					path,
					state: "invalid",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return result;
}

/** Reads, verifies, and parses one skill from the same byte buffer. */
export async function activateSkill(
	entry: SkillSnapshotEntry,
	capability: CapabilityRef,
	context: CapabilityContext,
	accountant: TokenAccountant,
	scope: "step" | "task" = "task",
) {
	const buffer = await readFile(entry.path);
	if (rawHash(buffer) !== entry.ref.bodyHash)
		throw new Error("STALE_CAPABILITY");
	const parsed = parseSkillBuffer(buffer);
	if (structuredHash(parsed.manifest) !== entry.ref.manifestHash)
		throw new Error("STALE_CAPABILITY");
	return context.admit({
		capability,
		scope,
		contentHash: entry.ref.bodyHash,
		content: parsed.body,
		accountant,
	});
}

export async function availableSkills(
	workspace: string,
	home = homedir(),
): Promise<Skill[]> {
	const { skills } = await loadSkills(
		new NodeExecutionEnv({ cwd: workspace }),
		skillRoots(workspace, home),
	);
	const byName = new Map<string, Skill>();
	for (const skill of skills)
		if (!byName.has(skill.name)) byName.set(skill.name, skill);
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function invokeSkills(
	workspace: string,
	text: string,
	home = homedir(),
): Promise<string> {
	const byName = new Map(
		(await availableSkills(workspace, home)).map((skill) => [
			skill.name,
			skill,
		]),
	);
	const selected: Skill[] = [];
	const prompt = text
		.replace(
			/(^|\s)\/([a-z0-9-]+)(?=$|\s|[.,!?;:])/g,
			(match, prefix, name) => {
				const skill = byName.get(name);
				if (!skill) return match;
				if (!selected.includes(skill)) selected.push(skill);
				return prefix;
			},
		)
		.trim();
	return selected.length
		? [...selected.map((skill) => formatSkillInvocation(skill)), prompt]
				.filter(Boolean)
				.join("\n\n")
		: text;
}

type StrictSkillManifest = {
	id: string;
	description: string;
	modelInvocable: boolean;
	tags: string[];
};

function parseSkillBuffer(buffer: Uint8Array): {
	manifest: StrictSkillManifest;
	body: string;
} {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match?.[1]) throw new Error("missing skill frontmatter");
	const fields = new Map<string, string>();
	for (const line of match[1].split(/\r?\n/)) {
		if (!line.trim()) continue;
		const separator = line.indexOf(":");
		if (separator < 1) throw new Error("invalid skill frontmatter");
		const key = line.slice(0, separator).trim();
		if (fields.has(key)) throw new Error(`duplicate skill field: ${key}`);
		fields.set(key, line.slice(separator + 1).trim());
	}
	const id = fields.get("id");
	const description = fields.get("description");
	const modelInvocable = fields.get("modelInvocable");
	if (!id || !/^[a-z0-9][a-z0-9-]*$/.test(id))
		throw new Error("skill id must use lowercase letters, digits, and hyphens");
	if (!description || description.length > 2_000)
		throw new Error(
			"skill description is required and limited to 2000 characters",
		);
	if (modelInvocable !== "true" && modelInvocable !== "false")
		throw new Error("skill modelInvocable must be true or false");
	const tagsValue = fields.get("tags");
	const tags = tagsValue
		? tagsValue
				.replace(/^\[/, "")
				.replace(/\]$/, "")
				.split(",")
				.map((tag) => tag.trim())
				.filter(Boolean)
		: [];
	if (tags.some((tag) => tag.length > 100))
		throw new Error("skill tags are limited to 100 characters");
	return {
		manifest: {
			id,
			description,
			modelInvocable: modelInvocable === "true",
			tags,
		},
		body: text.slice(match[0].length),
	};
}
