import pino from "pino";

export const log = pino({
	level:
		process.env["HARNEZ_LOG_LEVEL"] ??
		process.env["HARNESS_LOG_LEVEL"] ??
		"info",
	base: { service: "harnez-server" },
	redact: ["*.authorization", "*.apiKey", "*.key", "*.token"],
});
