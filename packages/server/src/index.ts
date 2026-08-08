import { serveHarness } from "./server";

const server = serveHarness({ port: Number(process.env.HARNESS_PORT ?? 7432) });
console.log(`Harness server listening on ${server.url}`);
