import type {
	ClientCommand,
	ServerEvent,
	StreamLine,
} from "../../shared/src/protocol";
import { VERSION } from "../../shared/src/version";
import type { SubagentResult } from "./context/types";
import { log } from "./logger";
import { HarnezServer } from "./server";
import { SessionStore } from "./sessions/store";
import type { RuntimeEventSink } from "./telemetry/events";

type ServeHarnezOptions = {
	port?: number;
	workspace?: string;
	databasePath?: string;
	contextBudget?: number;
	telemetry?: { sink: RuntimeEventSink; shutdown: () => Promise<void> };
};

export function serveHarnez(
	options: ServeHarnezOptions = {},
): ReturnType<typeof Bun.serve> {
	const harnez = new HarnezServer(
		new SessionStore(options.databasePath),
		options.workspace,
		undefined,
		undefined,
		options.contextBudget === undefined
			? options.telemetry
				? { telemetry: options.telemetry.sink }
				: {}
			: {
					contextBudget: options.contextBudget,
					...(options.telemetry ? { telemetry: options.telemetry.sink } : {}),
				},
	);
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 7432,
		idleTimeout: 0,
		fetch: (request) => fetchHarnez(harnez, request),
	});
	// Without this, stdio MCP servers outlive the process that spawned them.
	let shuttingDown = false;
	for (const signal of ["SIGINT", "SIGTERM"] as const)
		process.once(signal, () => {
			if (shuttingDown) return;
			shuttingDown = true;
			const hardExit = setTimeout(() => process.exit(0), 3_000);
			hardExit.unref?.();
			void harnez.close().then(
				async () => {
					await options.telemetry?.shutdown();
					process.exit(0);
				},
				(error) => {
					log.error({ err: error }, "graceful shutdown failed");
					process.exit(1);
				},
			);
		});
	return server;
}

async function fetchHarnez(
	harnez: HarnezServer,
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
		return Response.json(harnez.store.list());
	if (request.method === "POST" && url.pathname === "/sessions")
		return createSession(harnez, request);
	const match = url.pathname.match(
		/^\/sessions\/([^/]+)(?:\/(events|commands|context|subagent-results))?$/,
	);
	const [, id, action] = match ?? [];
	if (!id) return new Response("not found", { status: 404 });
	try {
		if (request.method === "POST" && action === "subagent-results")
			return await acceptSubagentResult(harnez, id, request);
		if (request.method === "GET" && action === "context")
			return Response.json(harnez.contextStatus(id));
		if (request.method === "GET" && action === "events")
			return eventStream(
				harnez,
				id,
				request,
				requestId,
				Math.max(0, Number(url.searchParams.get("from")) || 0),
			);
		if (request.method === "POST" && action === "commands")
			return await acceptCommand(harnez, id, request, requestId);
		if (request.method === "GET" && !action)
			return Response.json({
				sessionId: id,
				events: harnez.store.events(id),
			});
	} catch (error) {
		log.error({ err: error, requestId, sessionId: id }, "http request failed");
		return errorResponse(error, 404);
	}
	return new Response("not found", { status: 404 });
}

async function createSession(
	harnez: HarnezServer,
	request: Request,
): Promise<Response> {
	try {
		return Response.json({
			sessionId: harnez.createSession(await sessionWorkspace(request)),
		});
	} catch (error) {
		return errorResponse(error, 400);
	}
}

async function acceptSubagentResult(
	harnez: HarnezServer,
	id: string,
	request: Request,
): Promise<Response> {
	const handoff = parseSubagentHandoff(await request.json());
	return Response.json(
		harnez.acceptSubagentResult(id, handoff.result, handoff.subagentId),
		{ status: 201 },
	);
}

async function acceptCommand(
	harnez: HarnezServer,
	id: string,
	request: Request,
	requestId: string,
): Promise<Response> {
	harnez.workspace(id); // Validate before detaching the command.
	void harnez
		.command(id, (await request.json()) as ClientCommand)
		.catch((error) => {
			log.error({ err: error, requestId, sessionId: id }, "command failed");
			harnez.reportError(id, error);
		});
	return new Response(null, { status: 202 });
}

function eventStream(
	harnez: HarnezServer,
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
			const unsubscribe = harnez.subscribe(id, write, from);
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
					disconnect(harnez, id, requestId, controller, unsubscribe, heartbeat),
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
	harnez: HarnezServer,
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
	void harnez
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
