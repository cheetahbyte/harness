import type {
	ClientCommand,
	ServerEvent,
	StreamLine,
} from "../../shared/src/protocol";

export type StreamOptions = {
	signal: AbortSignal;
	onEvent: (event: ServerEvent) => void;
	/**
	 * Reports the resume cursor as each sequenced event is applied. Called before
	 * the stream can fail, so the caller keeps a usable cursor after a drop.
	 */
	onCursor?: (seq: number) => void;
	onConnected?: () => void;
	/** Resume after this cursor instead of replaying the whole session. */
	from?: number;
};

export class HarnessClient {
	constructor(
		readonly base = process.env["HARNEZ_URL"] ??
			process.env["HARNESS_URL"] ??
			"http://127.0.0.1:7432",
	) {}

	async createSession(workspace = process.cwd()): Promise<string> {
		const response = await fetch(`${this.base}/sessions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cwd: workspace }),
		});
		if (!response.ok)
			throw new Error(`session creation failed (${response.status})`);
		const body: unknown = await response.json();
		if (
			!body ||
			typeof body !== "object" ||
			!("sessionId" in body) ||
			typeof body.sessionId !== "string" ||
			!body.sessionId
		)
			throw new Error("session creation returned an invalid response");
		return body.sessionId;
	}

	async send(sessionId: string, command: ClientCommand): Promise<void> {
		const response = await fetch(
			`${this.base}/sessions/${sessionId}/commands`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(command),
			},
		);
		if (!response.ok) {
			const body = (await response.json().catch(() => ({}))) as {
				error?: unknown;
			};
			throw new Error(
				typeof body.error === "string"
					? body.error
					: `command failed (${response.status})`,
			);
		}
	}

	async stream(sessionId: string, options: StreamOptions): Promise<void> {
		const { signal, onEvent, onCursor, onConnected, from = 0 } = options;
		const url = new URL(`${this.base}/sessions/${sessionId}/events`);
		if (from) url.searchParams.set("from", String(from));
		const response = await fetch(url, { signal });
		if (!response.body) throw new Error("event stream unavailable");
		onConnected?.();
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
				// Blank lines are the server's keepalive heartbeat.
				for (const line of lines) {
					if (!line) continue;
					const { seq, event } = JSON.parse(line) as StreamLine;
					onEvent(event);
					if (seq !== undefined) onCursor?.(seq);
				}
			}
		} finally {
			reader.releaseLock();
		}
	}
}
