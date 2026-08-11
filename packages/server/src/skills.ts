import { homedir } from "node:os";
import { join } from "node:path";
import {
	formatSkillInvocation,
	loadSkills,
	type Skill,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

function skillRoots(workspace: string, home = homedir()): string[] {
	return [
		join(workspace, ".harness/skills"),
		join(workspace, ".agents/skills"),
		join(home, ".harness/skills"),
		join(home, ".agents/skills"),
	];
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
