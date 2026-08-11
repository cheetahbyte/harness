import { serveHarness } from "./http-server";
import { log } from "./logger";

const contextBudget = process.env["HARNESS_CONTEXT_BUDGET"];
const server = serveHarness({
	port: Number(process.env["HARNESS_PORT"] ?? 7432),
	...(contextBudget === undefined
		? {}
		: { contextBudget: Number(contextBudget) }),
});
log.info({ url: server.url }, "server listening");
