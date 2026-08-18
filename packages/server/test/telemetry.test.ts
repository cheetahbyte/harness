import { describe, expect, test } from "bun:test";
import { captureContent, sanitizedChildEnvironment, RuntimeTelemetry, sanitizeEvent } from "../src/telemetry/runtime";

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

	test("redacts content, credentials, and paths unless independently allowed", () => {
		const event = sanitizeEvent({
			type: "tool.call.completed", timestamp: new Date().toISOString(), sessionId: "s",
			tool: "bash", input: "cat /Users/alice/key", output: "token=secret",
			path: "/Users/alice/file", apiKey: "do-not-export",
		});
		expect(event["input"]).toBeUndefined();
		expect(event["output"]).toBeUndefined();
		expect(event["path"]).toBeUndefined();
		expect(event["apiKey"]).toBeUndefined();
		expect(sanitizeEvent({ ...event, input: "safe" }, new Set(["tool-arguments"]))["input"]).toBe("safe");
	});

	test("redacts sensitive fields for every lifecycle event kind", () => {
		const types = ["session.started", "task.started", "turn.started", "model.request.started", "model.request.completed", "model.request.failed", "tool.call.started", "tool.call.completed", "tool.call.failed", "skill.discovered", "skill.inspected", "skill.activated", "capability.snapshot.created", "context.assembly.completed", "context.assembly.failed", "context.compaction.completed", "approval.requested", "approval.resolved", "subagent.started", "subagent.completed", "subagent.failed"] as const;
		for (const type of types) {
			const event = sanitizeEvent({ type, timestamp: "now", sessionId: "s", prompt: "secret prompt", response: "secret response", toolArguments: "args", toolResults: "result", mcpPayload: "payload", imageBytes: new Uint8Array([1]), authorization: "Bearer key", path: "/Users/private/file" });
			expect(event["prompt"]).toBeUndefined();
			expect(event["response"]).toBeUndefined();
			expect(event["authorization"]).toBeUndefined();
			expect(event["imageBytes"]).toBeUndefined();
		}
	});
});
