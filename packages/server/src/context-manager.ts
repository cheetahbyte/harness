import type { SessionStore } from "./session-store";

export type ContextLifecycle = "pinned" | "active" | "retained" | "archived";
export type ContextProjection = "full" | "compact" | "reference" | "omitted";
export type ContextKind =
	| "system"
	| "user"
	| "assistant"
	| "tool-result"
	| "observation"
	| "pinned-note"
	| "subagent-handoff";
export type ContextSource = {
	toolCallId?: string;
	toolName?: string;
	observationId?: string;
	subagentId?: string;
	isError?: boolean;
};
export type ContextItem = {
	id: string;
	sessionId: string;
	sequence: number;
	kind: ContextKind;
	payload: unknown;
	compactPayload?: unknown;
	tokenCost: number;
	compactTokenCost?: number;
	source?: ContextSource;
	groupId?: string;
	episodeId?: string;
	lifecycle: ContextLifecycle;
	projection: ContextProjection;
	reason: string;
	createdAt: string;
	updatedAt: string;
};
export type NewContextItem = Omit<ContextItem, "sequence" | "updatedAt">;
export type NewEpisodeEvent = {
	id: string;
	sessionId: string;
	episodeId: string;
	action: "start" | "end";
	name: string;
	kind: "exploration" | "action";
	dependencies: string[];
	conclusion?: string;
	createdAt: string;
};
export type ContextEpisodeEvent = NewEpisodeEvent & { sequence: number };

export type SubagentResult = {
	status: "completed" | "blocked" | "failed";
	findings: string[];
	decisions: string[];
	changedFiles: string[];
	verification: string[];
	unresolvedIssues: string[];
	artifactRefs: string[];
};

type RecordInput = Omit<NewContextItem, "id" | "createdAt" | "projection"> & {
	id?: string;
	createdAt?: string;
	projection?: ContextProjection;
};

const kinds = new Set<ContextKind>([
	"system",
	"user",
	"assistant",
	"tool-result",
	"observation",
	"pinned-note",
	"subagent-handoff",
]);
const lifecycles = new Set<ContextLifecycle>([
	"pinned",
	"active",
	"retained",
	"archived",
]);

export class ContextManager {
	constructor(private readonly store: SessionStore) {}

	record(input: RecordInput): ContextItem {
		const knownKind = kinds.has(input.kind);
		const createdAt = input.createdAt ?? new Date().toISOString();
		return this.store.appendContextItem({
			...input,
			id: input.id ?? crypto.randomUUID(),
			kind: knownKind ? input.kind : "pinned-note",
			lifecycle:
				knownKind && lifecycles.has(input.lifecycle)
					? input.lifecycle
					: "pinned",
			projection: input.projection ?? "full",
			createdAt,
		});
	}

	archive(id: string, reason: string): void {
		const item = this.store.contextItem(id);
		if (item?.kind !== "tool-result" || item.lifecycle !== "retained")
			throw new Error("Only retained tool results can be archived");
		this.store.setContextLifecycle(
			id,
			"archived",
			item.compactPayload === undefined ? "reference" : "compact",
			reason,
		);
	}

	completeTurn(sessionId: string, newToolResultIds: string[] = []): void {
		const newToolCallIds = new Set(newToolResultIds);
		for (const item of this.store.contextItems(sessionId))
			if (
				item.kind === "tool-result" &&
				item.lifecycle === "active" &&
				!newToolCallIds.has(item.source?.toolCallId ?? "")
			)
				this.store.setContextLifecycle(
					item.id,
					"retained",
					item.projection,
					"consumed by a later model turn",
				);
	}

	recordSubagentResult(
		sessionId: string,
		result: SubagentResult,
		source: Pick<ContextSource, "subagentId"> = {},
	): ContextItem {
		return this.record({
			sessionId,
			kind: "subagent-handoff",
			payload: result,
			tokenCost: Math.ceil(JSON.stringify(result).length / 4),
			lifecycle: "retained",
			reason: "structured subagent handoff",
			source,
		});
	}
}
