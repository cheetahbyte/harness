import { serveHarnez } from "./http-server";
import { log } from "./logger";
import { startOpenTelemetry } from "./telemetry/opentelemetry";

export function runServer(): ReturnType<typeof Bun.serve> {
	const telemetry = startOpenTelemetry();
	const databasePath =
		process.env["HARNEZ_DATABASE_PATH"] ?? process.env["HARNESS_DATABASE_PATH"];
	const server = serveHarnez({
		port: Number(
			process.env["HARNEZ_PORT"] ?? process.env["HARNESS_PORT"] ?? 7432,
		),
		...(databasePath === undefined ? {} : { databasePath }),
		telemetry,
	});
	log.info({ url: server.url }, "server listening");
	return server;
}

if (import.meta.main) runServer();
