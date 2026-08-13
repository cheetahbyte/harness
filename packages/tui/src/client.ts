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

export type SessionSummary = {
	id: string;
	createdAt: string;
	workspace: string | null;
	title: string | null;
};

/**
 * Reads a JSON body as the named operation. The server answers JSON on every
 * success, so a parse failure means something else replied — a proxy, or a
 * truncated body — and it reads as that rather than as a bare SyntaxError.
 */
async function readJson(
	response: Response,
	operation: string,
): Promise<unknown> {
	try {
		return await response.json();
	} catch (error) {
		throw new Error(
			`${operation} returned a malformed response (${response.status})`,
			{ cause: error },
		);
	}
}

export class HarnezClient {
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
		const body: unknown = await readJson(response, "session creation");
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

	async listSessions(): Promise<SessionSummary[]> {
		const response = await fetch(`${this.base}/sessions`);
		if (!response.ok)
			throw new Error(`session listing failed (${response.status})`);
		const body: unknown = await readJson(response, "session listing");
		if (
			!Array.isArray(body) ||
			body.some(
				(session) =>
					!session ||
					typeof session !== "object" ||
					typeof session.id !== "string" ||
					!session.id ||
					typeof session.createdAt !== "string" ||
					!session.createdAt ||
					(session.workspace !== null &&
						typeof session.workspace !== "string") ||
					(session.title !== null && typeof session.title !== "string"),
			)
		)
			throw new Error("session listing returned an invalid response");
		return body as SessionSummary[];
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
