import { resolve } from "node:path";
import type { ClientCommand, ServerEvent } from "../../shared/src/protocol";
import { HarnessAgentRuntime } from "./agent-runtime";
import { ContextManager, type SubagentResult } from "./context-manager";
import { type HarnessModelConfig, JsonCredentialStore } from "./provider";
import { SessionStore } from "./session-store";
import { CoreTools } from "./tools";

type PendingCommand = { id: string; type: "steer" | "follow-up"; text: string };
type Session = {
	listeners: Set<(event: ServerEvent) => void>;
	running?: AbortController;
	followUps: PendingCommand[];
	pendingSteer?: PendingCommand;
};

export class HarnessServer {
	private readonly sessions = new Map<string, Session>();
	private readonly runtime: HarnessAgentRuntime;
	private readonly context: ContextManager;

	constructor(
		readonly store = new SessionStore(),
		workspace = process.cwd(),
		options: { contextBudget?: number } = {},
	) {
		if (
			options.contextBudget !== undefined &&
			(!Number.isSafeInteger(options.contextBudget) ||
				options.contextBudget <= 0)
		)
			throw new Error("context budget must be a positive number");
		this.context = new ContextManager(this.store);
		this.runtime = new HarnessAgentRuntime(
			new CoreTools(resolve(workspace)),
			new JsonCredentialStore(resolve(workspace, ".harness/auth.json")),
			this.store,
			this.context,
			options.contextBudget,
		);
	}

	createSession(): string {
		const id = this.store.create();
		this.sessions.set(id, { listeners: new Set(), followUps: [] });
		return id;
	}

	contextStatus(id: string) {
		this.session(id);
		return this.runtime.inspect(id);
	}

	acceptSubagentResult(
		id: string,
		result: SubagentResult,
		subagentId: string,
		trace?: string,
	) {
		this.session(id);
		const artifactRefs = [...result.artifactRefs];
		if (trace !== undefined) {
			const observation = this.context.recordObservation(id, trace, {
				subagentId,
			});
			artifactRefs.push(`observation://${observation.id}`);
		}
		return this.context.recordSubagentResult(
			id,
			{ ...result, artifactRefs: [...new Set(artifactRefs)] },
			{ subagentId },
		);
	}

	subscribe(id: string, listener: (event: ServerEvent) => void): () => void {
		const session = this.session(id);
		session.listeners.add(listener);
		for (const event of this.store.events(id)) listener(event);
		return () => session.listeners.delete(listener);
	}

	async command(id: string, command: ClientCommand): Promise<void> {
		const session = this.session(id);
		if (command.type === "abort") {
			session.running?.abort();
			return;
		}
		if (command.type === "configure") {
			if (session.running) throw new Error("cannot change model while running");
			const config: HarnessModelConfig = {
				provider: command.provider,
				model: command.model,
				baseUrl: command.baseUrl,
			};
			this.store.setModelConfig(id, config);
			this.runtime.forget(id);
			this.emit(id, {
				type: "status",
				text: `configured ${command.provider}/${command.model}`,
			});
			return;
		}
		if (command.type === "follow-up") {
			const pending = this.pending(command);
			session.followUps.push(pending);
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: pending.type,
				state: "queued",
			});
			this.emit(id, { type: "status", text: "follow-up queued" });
			return;
		}
		if (command.type === "steer") {
			const pending = this.pending(command);
			if (session.running) {
				if (session.pendingSteer)
					this.emit(id, {
						type: "command",
						id: session.pendingSteer.id,
						command: "steer",
						state: "replaced",
					});
				session.pendingSteer = pending;
				session.running.abort();
				this.emit(id, {
					type: "status",
					text: "steering after current cancellation",
				});
				return;
			}
			await this.run(id, pending);
			return;
		}
		await this.run(id, command.text);
	}

	private async run(
		id: string,
		command: string | PendingCommand,
	): Promise<void> {
		const session = this.session(id);
		if (session.running) return; // The steering command has aborted it; its caller owns the next run.
		const controller = new AbortController();
		session.running = controller;
		const pending = typeof command === "string" ? undefined : command;
		const text = typeof command === "string" ? command : command.text;
		if (pending)
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: pending.type,
				state: "started",
			});
		this.emit(id, { type: "status", text: "running" });
		try {
			await this.runtime.run(
				id,
				text,
				this.store.modelConfig(id),
				controller.signal,
				(event) => this.emit(id, event),
			);
		} catch (error) {
			this.emit(id, {
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
		session.running = undefined;
		if (controller.signal.aborted) {
			this.emit(id, { type: "aborted" });
			const steer = session.pendingSteer;
			session.pendingSteer = undefined;
			if (pending?.type === "follow-up")
				this.emit(id, {
					type: "command",
					id: pending.id,
					command: pending.type,
					state: "finished",
				});
			if (steer) await this.run(id, steer);
			return;
		}
		this.emit(id, { type: "completed" });
		if (pending?.type === "follow-up")
			this.emit(id, {
				type: "command",
				id: pending.id,
				command: pending.type,
				state: "finished",
			});
		const followUp = session.followUps.shift();
		if (followUp) await this.run(id, followUp);
	}

	private pending(
		command: Extract<ClientCommand, { type: "steer" | "follow-up" }>,
	): PendingCommand {
		return {
			id: command.id ?? crypto.randomUUID(),
			type: command.type,
			text: command.text,
		};
	}

	private session(id: string): Session {
		if (!this.store.exists(id)) throw new Error("session not found");
		let session = this.sessions.get(id);
		if (!session) {
			session = { listeners: new Set(), followUps: [] };
			this.sessions.set(id, session);
		}
		return session;
	}

	private emit(id: string, event: ServerEvent): void {
		this.store.append(id, event);
		for (const listener of this.session(id).listeners) listener(event);
	}
}

export function serveHarness(
	options: {
		port?: number;
		workspace?: string;
		databasePath?: string;
		contextBudget?: number;
	} = {},
): ReturnType<typeof Bun.serve> {
	const harness = new HarnessServer(
		new SessionStore(options.databasePath),
		options.workspace,
		{ contextBudget: options.contextBudget },
	);
	return Bun.serve({
		port: options.port ?? 7432,
		idleTimeout: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method === "POST" && url.pathname === "/sessions")
				return Response.json({ sessionId: harness.createSession() });
			const match = url.pathname.match(
				/^\/sessions\/([^/]+)(?:\/(events|commands|context|subagent-results))?$/,
			);
			if (!match) return new Response("not found", { status: 404 });
			const [, id, action] = match;
			try {
				if (request.method === "POST" && action === "subagent-results") {
					const handoff = parseSubagentHandoff(await request.json());
					return Response.json(
						harness.acceptSubagentResult(
							id,
							handoff.result,
							handoff.subagentId,
							handoff.trace,
						),
						{ status: 201 },
					);
				}
				if (request.method === "GET" && action === "context") {
					return Response.json(harness.contextStatus(id));
				}
				if (request.method === "GET" && action === "events") {
					const stream = new ReadableStream<Uint8Array>({
						start(controller) {
							const write = (event: ServerEvent) =>
								controller.enqueue(
									new TextEncoder().encode(`${JSON.stringify(event)}\n`),
								);
							write({ type: "session", sessionId: id });
							const unsubscribe = harness.subscribe(id, write);
							request.signal.addEventListener(
								"abort",
								() => {
									unsubscribe();
									controller.close();
								},
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
				if (request.method === "POST" && action === "commands") {
					await harness.command(id, (await request.json()) as ClientCommand);
					return new Response(null, { status: 202 });
				}
				if (request.method === "GET" && !action)
					return Response.json({
						sessionId: id,
						events: harness.store.events(id),
					});
			} catch (error) {
				return Response.json(
					{ error: error instanceof Error ? error.message : String(error) },
					{ status: 404 },
				);
			}
			return new Response("not found", { status: 404 });
		},
	});
}

function parseSubagentHandoff(value: unknown): {
	subagentId: string;
	result: SubagentResult;
	trace?: string;
} {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("invalid subagent result");
	const input = value as Record<string, unknown>;
	if (typeof input.subagentId !== "string" || !input.subagentId.trim())
		throw new Error("invalid subagent id");
	if (
		!input.result ||
		typeof input.result !== "object" ||
		Array.isArray(input.result)
	)
		throw new Error("invalid subagent result");
	if (input.trace !== undefined && typeof input.trace !== "string")
		throw new Error("invalid subagent trace");
	const result = input.result as Record<string, unknown>;
	if (
		result.status !== "completed" &&
		result.status !== "blocked" &&
		result.status !== "failed"
	)
		throw new Error("invalid subagent status");
	return {
		subagentId: input.subagentId,
		result: {
			status: result.status,
			findings: stringArray(result.findings, "findings"),
			decisions: stringArray(result.decisions, "decisions"),
			changedFiles: stringArray(result.changedFiles, "changed files"),
			verification: stringArray(result.verification, "verification"),
			unresolvedIssues: stringArray(
				result.unresolvedIssues,
				"unresolved issues",
			),
			artifactRefs: stringArray(result.artifactRefs, "artifact refs"),
		},
		...(input.trace === undefined ? {} : { trace: input.trace }),
	};
}

function stringArray(value: unknown, name: string): string[] {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
		throw new Error(`invalid subagent ${name}`);
	return value as string[];
}
