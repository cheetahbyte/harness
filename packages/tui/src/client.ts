import type { ClientCommand, ServerEvent } from "../../shared/src/protocol";

export class HarnessClient {
	constructor(
		readonly base = process.env["HARNESS_URL"] ?? "http://localhost:7432",
	) {}

	async createSession(): Promise<string> {
		return (
			(await (
				await fetch(`${this.base}/sessions`, { method: "POST" })
			).json()) as { sessionId: string }
		).sessionId;
	}

	async send(sessionId: string, command: ClientCommand): Promise<void> {
		await fetch(`${this.base}/sessions/${sessionId}/commands`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(command),
		});
	}

	async stream(
		sessionId: string,
		onEvent: (event: ServerEvent) => void,
		signal: AbortSignal,
	): Promise<void> {
		const response = await fetch(`${this.base}/sessions/${sessionId}/events`, {
			signal,
		});
		if (!response.body) throw new Error("event stream unavailable");
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let pending = "";
		try {
			while (!signal.aborted) {
				const next = await reader.read();
				if (next.done) break;
				pending += decoder.decode(next.value, { stream: true });
				const lines = pending.split("\n");
				pending = lines.pop() ?? "";
				for (const line of lines)
					if (line) onEvent(JSON.parse(line) as ServerEvent);
			}
		} finally {
			reader.releaseLock();
		}
	}
}
