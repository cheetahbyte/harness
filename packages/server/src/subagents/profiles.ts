import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import type { ModelConfig } from "../../../shared/src/protocol";
import type { CapabilityInput } from "../capabilities/types";

export type ProfileCapabilities =
	| "all"
	| { core: string[]; skills: string[]; mcp: string[] };

export type AgentProfile = {
	name: string;
	description: string;
	body: string;
	model?: string;
	thinking?: ModelThinkingLevel;
	capabilities: ProfileCapabilities;
	path: string;
};

export type AgentProfileDiagnostic = {
	path: string;
	state: "invalid" | "unreadable" | "shadowed";
	error: string;
};

export type AgentProfileScan = {
	profiles: AgentProfile[];
	diagnostics: AgentProfileDiagnostic[];
};

export type AgentProfileEnvironment = {
	parentModel: ModelConfig | undefined;
	resolveModel: (config: ModelConfig) => void;
	capabilities: readonly CapabilityInput[];
};

export type ResolvedAgentProfile = Omit<AgentProfile, "capabilities"> & {
	modelConfig: ModelConfig;
	capabilities: readonly CapabilityInput[];
	coreNames: ReadonlySet<string>;
};

const THINKING_LEVELS = new Set<ModelThinkingLevel>([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const PROFILE_NAME = /^[a-z0-9][a-z0-9-]*$/;

const BUILT_INS: readonly AgentProfile[] = [
	{
		name: "general-purpose",
		description: "Handle a bounded task with all workspace capabilities.",
		body: "Complete only the assigned work package and report a structured result.",
		capabilities: "all",
		path: "builtin:general-purpose",
	},
	{
		name: "explore",
		description:
			"Inspect the codebase and report evidence without editing files.",
		body: "Inspect first. Use bash only for read-oriented commands; bash is trusted execution, not a read-only sandbox.",
		capabilities: { core: ["read", "bash"], skills: [], mcp: [] },
		path: "builtin:explore",
	},
];

function profileRoots(workspace: string, home = homedir()): string[] {
	return [
		join(workspace, ".harnez/agents"),
		join(workspace, ".harness/agents"),
		join(workspace, ".agents/agents"),
		join(home, ".harnez/agents"),
		join(home, ".harness/agents"),
		join(home, ".agents/agents"),
	];
}

/** Scan metadata only; invalid files never reserve a profile name. */
export async function scanAgentProfiles(
	workspace: string,
	home = homedir(),
): Promise<AgentProfileScan> {
	const result: AgentProfileScan = { profiles: [], diagnostics: [] };
	const claimed = new Set<string>();
	for (const root of profileRoots(workspace, home)) {
		let entries;
		try {
			entries = await readdir(root, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				result.diagnostics.push({
					path: root,
					state: "unreadable",
					error: errorMessage(error),
				});
			continue;
		}
		for (const entry of entries
			.filter(
				(candidate) => candidate.isFile() && candidate.name.endsWith(".md"),
			)
			.toSorted((a, b) => a.name.localeCompare(b.name))) {
			const path = join(root, entry.name);
			try {
				const profile = parseAgentProfile(await readFile(path, "utf8"), path);
				if (claimed.has(profile.name)) {
					result.diagnostics.push({
						path,
						state: "shadowed",
						error: `profile ${profile.name} is already defined by a higher-priority file`,
					});
					continue;
				}
				claimed.add(profile.name);
				result.profiles.push(profile);
			} catch (error) {
				result.diagnostics.push({
					path,
					state: "invalid",
					error: errorMessage(error),
				});
			}
		}
	}
	for (const profile of BUILT_INS)
		if (!claimed.has(profile.name)) {
			claimed.add(profile.name);
			result.profiles.push(profile);
		}
	return result;
}

function parseAgentProfile(text: string, path: string): AgentProfile {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	if (!match) throw new Error("missing profile frontmatter");
	const frontmatter = match[1];
	if (frontmatter === undefined) throw new Error("missing profile frontmatter");
	const raw = Bun.YAML.parse(frontmatter);
	if (!raw || typeof raw !== "object" || Array.isArray(raw))
		throw new Error("profile frontmatter must be a mapping");
	const fields = raw as Record<string, unknown>;
	const allowed = new Set([
		"name",
		"description",
		"model",
		"thinking",
		"capabilities",
	]);
	for (const key of Object.keys(fields))
		if (!allowed.has(key)) throw new Error(`unknown profile field ${key}`);
	const filename = basename(path, ".md");
	const explicitName = fields["name"];
	const name = explicitName === undefined ? filename : explicitName;
	if (typeof name !== "string" || !PROFILE_NAME.test(name))
		throw new Error(
			"profile name must use lowercase letters, digits, and hyphens",
		);
	const description = fields["description"];
	if (typeof description !== "string" || !description.trim())
		throw new Error("profile description is required");
	const model = fields["model"];
	if (model !== undefined && (typeof model !== "string" || !model.trim()))
		throw new Error("profile model must be a non-empty provider/model string");
	if (typeof model === "string") {
		const slash = model.indexOf("/");
		if (slash <= 0 || slash === model.length - 1)
			throw new Error(`malformed model reference ${model}`);
	}
	const thinking = fields["thinking"];
	if (
		thinking !== undefined &&
		(typeof thinking !== "string" ||
			!THINKING_LEVELS.has(thinking as ModelThinkingLevel))
	)
		throw new Error(`invalid thinking level ${String(thinking)}`);
	return {
		name,
		description,
		body: text.slice(match[0].length).trim(),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined
			? {}
			: { thinking: thinking as ModelThinkingLevel }),
		capabilities: parseCapabilities(fields["capabilities"]),
		path,
	};
}

function parseCapabilities(value: unknown): ProfileCapabilities {
	if (value === "all") return value;
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error(
			'profile capabilities must be "all" or an explicit mapping',
		);
	const fields = value as Record<string, unknown>;
	for (const key of Object.keys(fields))
		if (key !== "core" && key !== "skills" && key !== "mcp")
			throw new Error(`unknown capability category ${key}`);
	const lists = {} as { core: string[]; skills: string[]; mcp: string[] };
	for (const key of ["core", "skills", "mcp"] as const) {
		const list = fields[key];
		if (
			!Array.isArray(list) ||
			list.some((item) => typeof item !== "string" || !item.trim())
		)
			throw new Error(`capabilities.${key} must be an array of names`);
		lists[key] = [...list] as string[];
	}
	return lists;
}

export function resolveAgentProfile(
	scan: AgentProfileScan,
	name: string,
	environment: AgentProfileEnvironment,
): ResolvedAgentProfile {
	const profile = scan.profiles.find((candidate) => candidate.name === name);
	if (!profile) throw new Error(`Unknown subagent profile ${name}`);
	let modelConfig: ModelConfig;
	if (profile.model) {
		const slash = profile.model.indexOf("/");
		if (slash <= 0 || slash === profile.model.length - 1)
			throw new Error(`Malformed model reference ${profile.model}`);
		modelConfig = {
			...(environment.parentModel?.provider === profile.model.slice(0, slash)
				? { baseUrl: environment.parentModel.baseUrl }
				: {}),
			provider: profile.model.slice(0, slash),
			model: profile.model.slice(slash + 1),
		};
	} else if (environment.parentModel)
		modelConfig = { ...environment.parentModel };
	else
		throw new Error(
			`Profile ${name} requires a model because the parent has none`,
		);
	if (profile.thinking !== undefined)
		modelConfig.thinkingLevel = profile.thinking;
	else if (environment.parentModel?.thinkingLevel !== undefined)
		modelConfig.thinkingLevel = environment.parentModel.thinkingLevel;
	environment.resolveModel(modelConfig);

	const selected =
		profile.capabilities === "all"
			? [...environment.capabilities]
			: filterCapabilities(profile.capabilities, environment.capabilities);
	const coreNames = new Set(
		(profile.capabilities === "all" ? environment.capabilities : selected)
			.filter(
				(input) =>
					input.kind === "tool" &&
					input.providerBinding.providerId === "workspace",
			)
			.map((input) => input.name),
	);
	return { ...profile, modelConfig, capabilities: selected, coreNames };
}

function filterCapabilities(
	allow: Exclude<ProfileCapabilities, "all">,
	inputs: readonly CapabilityInput[],
): CapabilityInput[] {
	const ids = new Set([
		...allow.core.map((name) => `tool:${name}`),
		...allow.skills.map((name) => `skill:${name}`),
		...allow.mcp.map((name) => `tool:${name}`),
	]);
	for (const id of ids)
		if (!inputs.some((input) => input.id === id))
			throw new Error(`Unknown capability ${id}`);
	return inputs.filter((input) => ids.has(input.id));
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
