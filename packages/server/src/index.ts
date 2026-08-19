import { serveHarnez } from "./http-server";
import { log } from "./logger";
import { startOpenTelemetry } from "./telemetry/opentelemetry";

export function runServer(): ReturnType<typeof Bun.serve> {
	const telemetry = startOpenTelemetry();
	const contextBudget =
		process.env["HARNEZ_CONTEXT_BUDGET"] ??
		process.env["HARNESS_CONTEXT_BUDGET"];
	const databasePath =
		process.env["HARNEZ_DATABASE_PATH"] ?? process.env["HARNESS_DATABASE_PATH"];
	const server = serveHarnez({
		port: Number(
			process.env["HARNEZ_PORT"] ?? process.env["HARNESS_PORT"] ?? 7432,
		),
		...(databasePath === undefined ? {} : { databasePath }),
		...(contextBudget === undefined
			? {}
			: { contextBudget: Number(contextBudget) }),
		llmCompaction: process.env["HARNEZ_LLM_COMPACTION"] !== "0",
		telemetry,
	});
	log.info({ url: server.url }, "server listening");
	return server;
}

if (import.meta.main) runServer();
