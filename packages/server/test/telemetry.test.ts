import { describe, expect, test } from "bun:test";
import { captureContent, sanitizedChildEnvironment, RuntimeTelemetry } from "../src/telemetry/runtime";

describe("telemetry configuration", () => {
	test("parses capture categories and rejects unknown values", () => {
		expect([...captureContent("prompts, paths")]).toEqual(["prompts", "paths"]);
		expect(() => captureContent("secrets")).toThrow("unknown");
	});

	test("removes telemetry configuration from children", () => {
		const env = sanitizedChildEnvironment({ PATH: "/bin", OTEL_EXPORTER_OTLP_ENDPOINT: "secret", HARNEZ_OTEL: "1", HARNEZ_OTEL_CAPTURE_CONTENT: "prompts", OTHER: "kept" });
		expect(env).toEqual({ PATH: "/bin", OTHER: "kept" });
	});

	test("disabled runtime emits nothing", () => {
		const events: unknown[] = [];
		const telemetry = new RuntimeTelemetry({ enabled: false, sink: (event) => events.push(event) });
		telemetry.emit({ type: "session.started", sessionId: "s", timestamp: new Date().toISOString() });
		expect(events).toEqual([]);
	});
});
