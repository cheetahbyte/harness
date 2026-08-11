import pino from "pino";

export const log = pino({
	level: process.env["HARNESS_LOG_LEVEL"] ?? "info",
	base: { service: "harness-server" },
	redact: ["*.authorization", "*.apiKey", "*.key", "*.token"],
});
