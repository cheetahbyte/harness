import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadSkills, type Skill } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import type {
	CapabilityContext,
	TokenAccountant,
} from "./capabilities/context";
import { rawHash, structuredHash } from "./capabilities/hash";
import type { CapabilityRef, SkillCapabilityInput } from "./capabilities/types";

type SkillDiscoveryState = "discoverable" | "operator_only" | "invalid";
type SkillRef = {
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
type SkillDiagnostic = {
	path: string;
	state: "invalid";
	error: string;
};
export type SkillScan = {
	discoverable: SkillSnapshotEntry[];
	operatorOnly: SkillSnapshotEntry[];
	diagnostics: SkillDiagnostic[];
};

/** `.harness` is the pre-rename spelling, still read so older checkouts keep working. */
function skillRoots(workspace: string, home = homedir()): string[] {
	return [
		join(workspace, ".harnez/skills"),
		join(workspace, ".harness/skills"),
		join(workspace, ".agents/skills"),
		join(home, ".harnez/skills"),
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
						modelDiscoverable: !parsed.manifest.disableModelInvocation,
						providerBinding: {
							providerId: "skill-files",
							bindingGeneration: catalogGeneration,
						},
						manifestHash,
						bodyHash,
					},
					path,
					discoveryState: parsed.manifest.disableModelInvocation
						? "operator_only"
						: "discoverable",
				};
				(parsed.manifest.disableModelInvocation
					? result.operatorOnly
					: result.discoverable
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

type StrictSkillManifest = {
	id: string;
	description: string;
	disableModelInvocation: boolean;
	tags: string[];
};

function parseSkillBuffer(buffer: Uint8Array): {
	manifest: StrictSkillManifest;
	body: string;
} {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match?.[1]) throw new Error("missing skill frontmatter");
	const parsed = Bun.YAML.parse(match[1]);
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("invalid skill frontmatter");
	const fields = parsed as Record<string, unknown>;
	const explicitId = fields["id"];
	const name = fields["name"];
	if (explicitId !== undefined && name !== undefined && explicitId !== name)
		throw new Error("skill id and name must match");
	const id = explicitId ?? name;
	const description = fields["description"];
	const disableModelInvocation = fields["disable-model-invocation"];
	if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(id))
		throw new Error("skill id must use lowercase letters, digits, and hyphens");
	if (
		typeof description !== "string" ||
		!description.trim() ||
		description.length > 2_000
	)
		throw new Error(
			"skill description is required and limited to 2000 characters",
		);
	if (
		disableModelInvocation !== undefined &&
		typeof disableModelInvocation !== "boolean"
	)
		throw new Error("skill disable-model-invocation must be true or false");
	const tags = skillTags(fields["tags"]);
	if (tags.some((tag) => tag.length > 100))
		throw new Error("skill tags are limited to 100 characters");
	return {
		manifest: {
			id,
			description: description.trim(),
			disableModelInvocation: disableModelInvocation === true,
			tags,
		},
		body: text.slice(match[0].length),
	};
}

function skillTags(value: unknown): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) && typeof value !== "string")
		throw new Error("skill tags must be text");
	const tags = Array.isArray(value) ? value : value.split(",");
	if (tags.some((tag) => typeof tag !== "string"))
		throw new Error("skill tags must be text");
	return (tags as string[]).map((tag) => tag.trim()).filter(Boolean);
}
