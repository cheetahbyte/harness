import { log } from "./logger";
import { serveHarness } from "./server";

const contextBudget = process.env["HARNESS_CONTEXT_BUDGET"];
const server = serveHarness({
	port: Number(process.env["HARNESS_PORT"] ?? 7432),
	...(contextBudget === undefined
		? {}
		: { contextBudget: Number(contextBudget) }),
});
log.info({ url: server.url }, "server listening");
