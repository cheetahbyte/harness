import { BoxRenderable, type CliRenderer, TextRenderable } from "@opentui/core";

import type { SubagentStateEvent } from "../../../shared/src/protocol";
import { DIM } from "./theme";

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
		this.root.visible = agents.length > 0;
		this.text.content = tree(agents, now);
		this.text.fg = DIM;
	}
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
