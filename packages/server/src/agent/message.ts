import type { AgentMessage } from "@earendil-works/pi-agent-core";

export const messageKey = (message: AgentMessage): string =>
	JSON.stringify(message);

export function detailsRecord(details: unknown): Record<string, unknown> {
	return typeof details === "object" &&
		details !== null &&
		!Array.isArray(details)
		? (details as Record<string, unknown>)
		: {};
}
