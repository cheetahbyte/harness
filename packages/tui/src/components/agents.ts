import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";

import type { SubagentStateEvent } from "../../../shared/src/protocol";
import { DIM, TEXT, WARNING } from "./theme";

type Agent = SubagentStateEvent["agent"];

const NEEDS_INPUT = ["blocked"] as const;
const WORKING = ["queued", "running", "cancelling"] as const;
const COMPLETED = ["completed", "failed", "cancelled"] as const;

type AgentGroup = {
	label: string;
	agents: Agent[];
};

export class AgentsView {
	readonly root: BoxRenderable;
	private readonly text: TextRenderable;

	constructor(renderer: CliRenderer) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			flexDirection: "column",
			visible: false,
		});
		this.text = new TextRenderable(renderer, { content: "", fg: DIM });
		this.root.add(this.text);
	}

	update(agents: readonly SubagentStateEvent["agent"][], now = Date.now()) {
		const active = agents.filter((agent) =>
			["queued", "running", "cancelling"].includes(agent.state),
		);
		this.root.visible = active.length > 0;
		this.text.content = tree(active, now);
		this.text.fg = DIM;
	}
}

/** Full-screen agent browser. Key handling belongs to the app, not this view. */
export class GlobalAgentsView {
	readonly root: BoxRenderable;
	private readonly header: TextRenderable;
	private readonly body: TextRenderable;
	private agents: Agent[] = [];
	private selected = 0;

	constructor(renderer: CliRenderer, agents: readonly Agent[] = []) {
		this.root = new BoxRenderable(renderer, {
			width: "100%",
			height: "100%",
			flexGrow: 1,
			flexDirection: "column",
			padding: 1,
			visible: false,
		});
		this.header = new TextRenderable(renderer, { fg: TEXT });
		this.body = new TextRenderable(renderer, {
			fg: DIM,
			flexGrow: 1,
			wrapMode: "word",
		});
		this.root.add(this.header);
		this.root.add(this.body);
		this.update(agents);
	}

	get selectedId(): string | undefined {
		return this.selected === 0 ? undefined : this.agents[this.selected - 1]?.id;
	}

	update(agents: readonly Agent[]) {
		const selectedId = this.selectedId;
		const mainSelected = this.selected === 0;
		this.agents = groupAgents(agents).flatMap((group) => group.agents);
		const selectedIndex = selectedId
			? this.agents.findIndex((agent) => agent.id === selectedId)
			: -1;
		this.selected = mainSelected
			? 0
			: selectedIndex >= 0
				? selectedIndex + 1
				: Math.min(this.selected, this.agents.length);
		this.render();
	}

	moveSelection(delta: number) {
		if (!Number.isFinite(delta)) return;
		this.selected = Math.max(
			0,
			Math.min(this.agents.length, this.selected + Math.trunc(delta)),
		);
		this.render();
	}

	private render() {
		const groups = groupAgents(this.agents);
		const total = this.agents.length;
		this.header.content = `Global agents · ${total} total  ·  ${groups
			.map(({ label, agents }) => `${agents.length} ${label.toLowerCase()}`)
			.join("  ·  ")}`;
		const lines: string[] = [
			"",
			"Your conversation moved to the background — enter opens it · esc returns to it",
			"",
			`${this.selected === 0 ? "›" : " "} • main`,
		];
		let index = 1;
		for (const group of groups) {
			if (!group.agents.length) continue;
			lines.push("", `${group.label} (${group.agents.length})`);
			for (const agent of group.agents) {
				const marker = index === this.selected ? "›" : " ";
				const state =
					agent.state === "running"
						? "*"
						: agent.state === "queued"
							? "○"
							: "·";
				lines.push(
					`${marker} ${state} ${agent.profile} · ${agent.description} [${agent.state}]`,
				);
				if (agent.summary) lines.push(`    ╰ ${agent.summary.split("\n")[0]}`);
				index++;
			}
		}
		if (!total) lines.push("", "No child agents.");
		this.body.content = lines.join("\n");
		this.body.fg = total ? DIM : WARNING;
	}
}

function groupAgents(agents: readonly Agent[]): AgentGroup[] {
	return [
		{
			label: "Needs input",
			agents: agents.filter((agent) =>
				NEEDS_INPUT.includes(agent.state as never),
			),
		},
		{
			label: "Working",
			agents: agents.filter((agent) => WORKING.includes(agent.state as never)),
		},
		{
			label: "Completed",
			agents: agents.filter((agent) =>
				COMPLETED.includes(agent.state as never),
			),
		},
	];
}

export function line(agent: SubagentStateEvent["agent"], now: number): string {
	const started = Date.parse(agent.startedAt ?? new Date(now).toISOString());
	const elapsed = Math.max(0, now - started);
	const subject = agent.toolSubject ? ` · ${agent.toolSubject}` : "";
	return `${agent.profile} · ${agent.description} · ${formatElapsed(elapsed)}${subject}`;
}

function tree(
	agents: readonly SubagentStateEvent["agent"][],
	now = Date.now(),
): string {
	const byParent = new Map<string | undefined, SubagentStateEvent["agent"][]>();
	for (const agent of agents)
		byParent.set(agent.parentId, [
			...(byParent.get(agent.parentId) ?? []),
			agent,
		]);
	const rows: string[] = [];
	const visit = (parent: string | undefined) => {
		for (const agent of byParent.get(parent) ?? []) {
			const state =
				agent.state === "running" ? "●" : agent.state === "queued" ? "○" : "·";
			rows.push(
				`${"  ".repeat(agent.depth ?? 0)}${state} ${line(agent, now)} [${agent.state}]`,
			);
			visit(agent.id);
		}
	};
	visit(undefined);
	for (const agent of agents)
		if (!rows.some((row) => row.includes(agent.description)))
			rows.push(line(agent, now));
	return rows.join("\n");
}

export function formatElapsed(elapsedMs: number): string {
	const seconds = Math.floor(Math.max(0, elapsedMs) / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}
