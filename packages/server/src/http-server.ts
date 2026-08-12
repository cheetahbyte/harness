import type {
	ClientCommand,
	ServerEvent,
	StreamLine,
} from "../../shared/src/protocol";
import { VERSION } from "../../shared/src/version";
import type { SubagentResult } from "./context/types";
import { log } from "./logger";
import { HarnessServer } from "./server";
import { SessionStore } from "./sessions/store";

type ServeHarnessOptions = {
	port?: number;
	workspace?: string;
	databasePath?: string;
	contextBudget?: number;
};

export function serveHarness(
	options: ServeHarnessOptions = {},
): ReturnType<typeof Bun.serve> {
	const harness = new HarnessServer(
		new SessionStore(options.databasePath),
		options.workspace,
		undefined,
		undefined,
		options.contextBudget === undefined
			? {}
			: { contextBudget: options.contextBudget },
	);
	return Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 7432,
		idleTimeout: 0,
		fetch: (request) => fetchHarness(harness, request),
	});
}

async function fetchHarness(
	harness: HarnessServer,
	request: Request,
): Promise<Response> {
	const url = new URL(request.url);
	const requestId = crypto.randomUUID();
	log.debug(
		{ requestId, method: request.method, path: url.pathname },
		"http request",
	);
	if (request.method === "GET" && url.pathname === "/health")
		return Response.json({
			name: "harnez",
			pid: process.pid,
			version: VERSION,
		});
	if (request.method === "GET" && url.pathname === "/sessions")
		return Response.json(harness.store.list());
	if (request.method === "POST" && url.pathname === "/sessions")
		return createSession(harness, request);
	const match = url.pathname.match(
		/^\/sessions\/([^/]+)(?:\/(events|commands|context|subagent-results))?$/,
	);
	const [, id, action] = match ?? [];
	if (!id) return new Response("not found", { status: 404 });
	try {
		if (request.method === "POST" && action === "subagent-results")
			return await acceptSubagentResult(harness, id, request);
		if (request.method === "GET" && action === "context")
			return Response.json(harness.contextStatus(id));
		if (request.method === "GET" && action === "events")
			return eventStream(
				harness,
				id,
				request,
				requestId,
				Math.max(0, Number(url.searchParams.get("from")) || 0),
			);
		if (request.method === "POST" && action === "commands")
			return await acceptCommand(harness, id, request, requestId);
		if (request.method === "GET" && !action)
			return Response.json({
				sessionId: id,
				events: harness.store.events(id),
			});
	} catch (error) {
		log.error({ err: error, requestId, sessionId: id }, "http request failed");
		return errorResponse(error, 404);
	}
	return new Response("not found", { status: 404 });
}

async function createSession(
	harness: HarnessServer,
	request: Request,
): Promise<Response> {
	try {
		return Response.json({
			sessionId: harness.createSession(await sessionWorkspace(request)),
		});
	} catch (error) {
		return errorResponse(error, 400);
	}
}

async function acceptSubagentResult(
	harness: HarnessServer,
	id: string,
	request: Request,
): Promise<Response> {
	const handoff = parseSubagentHandoff(await request.json());
	return Response.json(
		harness.acceptSubagentResult(id, handoff.result, handoff.subagentId),
		{ status: 201 },
	);
}

async function acceptCommand(
	harness: HarnessServer,
	id: string,
	request: Request,
	requestId: string,
): Promise<Response> {
	harness.workspace(id); // Validate before detaching the command.
	void harness
		.command(id, (await request.json()) as ClientCommand)
		.catch((error) => {
			log.error({ err: error, requestId, sessionId: id }, "command failed");
			harness.reportError(id, error);
		});
	return new Response(null, { status: 202 });
}

function eventStream(
	harness: HarnessServer,
	id: string,
	request: Request,
	requestId: string,
	from: number,
): Response {
	log.info({ requestId, sessionId: id, from }, "event stream connected");
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const encoder = new TextEncoder();
			const write = (event: ServerEvent, seq?: number) =>
				controller.enqueue(
					encoder.encode(
						`${JSON.stringify(
							seq === undefined
								? ({ event } satisfies StreamLine)
								: ({ seq, event } satisfies StreamLine),
						)}\n`,
					),
				);
			write({ type: "session", sessionId: id });
			const unsubscribe = harness.subscribe(id, write, from);
			const heartbeat = setInterval(() => {
				try {
					controller.enqueue(encoder.encode("\n"));
				} catch {
					clearInterval(heartbeat);
				}
			}, 30_000);
			request.signal.addEventListener(
				"abort",
				() =>
					disconnect(
						harness,
						id,
						requestId,
						controller,
						unsubscribe,
						heartbeat,
					),
				{ once: true },
			);
		},
	});
	return new Response(stream, {
		headers: {
			"content-type": "application/x-ndjson",
			"cache-control": "no-cache",
		},
	});
}

function disconnect(
	harness: HarnessServer,
	id: string,
	requestId: string,
	controller: ReadableStreamDefaultController<Uint8Array>,
	unsubscribe: () => void,
	heartbeat: ReturnType<typeof setInterval>,
): void {
	log.info({ requestId, sessionId: id }, "event stream disconnected");
	clearInterval(heartbeat);
	unsubscribe();
	// Reconnects make disconnects routine, so cancellation must not escape.
	void harness
		.command(id, { type: "auth-cancel" })
		.catch((error) =>
			log.error(
				{ err: error, requestId, sessionId: id },
				"auth cancel on disconnect failed",
			),
		);
	controller.close();
}

async function sessionWorkspace(request: Request): Promise<string | undefined> {
	const text = await request.text();
	if (!text) return undefined;
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		throw new Error("session body must be valid JSON");
	}
	if (!body || typeof body !== "object" || Array.isArray(body))
		throw new Error("session body must be an object");
	const cwd = (body as { cwd?: unknown }).cwd;
	if (cwd !== undefined && (typeof cwd !== "string" || !cwd))
		throw new Error("cwd must be a non-empty string");
	return cwd;
}

function parseSubagentHandoff(value: unknown): {
	subagentId: string;
	result: SubagentResult;
} {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid subagent result");
	const input = value as Record<string, unknown>;
	const subagentId = input["subagentId"];
	if (typeof subagentId !== "string" || !subagentId.trim())
		throw new Error("invalid subagent id");
	const resultValue = input["result"];
	if (
		!resultValue ||
		typeof resultValue !== "object" ||
		Array.isArray(resultValue)
	)
		throw new Error("invalid subagent result");
	if (input["trace"] !== undefined)
		throw new Error("subagent traces must remain external");
	const result = resultValue as Record<string, unknown>;
	const status = result["status"];
	if (status !== "completed" && status !== "blocked" && status !== "failed")
		throw new Error("invalid subagent status");
	return {
		subagentId,
		result: {
			status,
			findings: stringArray(result["findings"], "findings"),
			decisions: stringArray(result["decisions"], "decisions"),
			changedFiles: stringArray(result["changedFiles"], "changed files"),
			verification: stringArray(result["verification"], "verification"),
			unresolvedIssues: stringArray(
				result["unresolvedIssues"],
				"unresolved issues",
			),
			artifactRefs: stringArray(result["artifactRefs"], "artifact refs"),
		},
	};
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		throw new Error(`invalid subagent ${name}`);
	return value as string[];
}

function errorResponse(error: unknown, status: number): Response {
	return Response.json(
		{ error: error instanceof Error ? error.message : String(error) },
		{ status },
	);
}
