import { log } from "./logger";
import { serveHarness } from "./server";

const server = serveHarness({
	port: Number(process.env["HARNESS_PORT"] ?? 7432),
});
log.info({ url: server.url }, "server listening");
