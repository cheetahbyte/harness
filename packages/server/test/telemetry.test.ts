import { describe, expect, test } from "bun:test";
import { captureContent, sanitizedChildEnvironment, RuntimeTelemetry, sanitizeEvent } from "../src/telemetry/runtime";
import { startOpenTelemetry } from "../src/telemetry/opentelemetry";

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

	test("exports lifecycle hierarchy, retries, sibling tools, statuses, and metrics", async () => {
		const spans: Array<Record<string, unknown>> = [];
		const metricBatches: Array<Record<string, unknown>> = [];
		const traceExporter = {
			export(batch: Array<Record<string, unknown>>, done: (result: unknown) => void) {
				spans.push(...batch);
				done({ code: 0 });
			},
			shutdown: async () => {},
		};
		const metricExporter = {
			export(batch: Record<string, unknown>, done: (result: unknown) => void) {
				metricBatches.push(batch);
				done({ code: 0 });
			},
			selectAggregationTemporality: () => 2,
			forceFlush: async () => {},
			shutdown: async () => {},
		};
		const telemetry = startOpenTelemetry({
			enabled: true,
			traceExporter,
			metricExporter,
		});
		const emit = telemetry.sink;
		const timestamp = new Date().toISOString();
		emit({ type: "session.started", sessionId: "s", timestamp });
		emit({ type: "task.started", sessionId: "s", taskId: "t", timestamp });
		emit({ type: "model.request.started", sessionId: "s", taskId: "t", requestId: 1, timestamp, provider: "p", model: "m", attempt: 1 });
		emit({ type: "model.request.failed", sessionId: "s", taskId: "t", requestId: 1, timestamp, provider: "p", model: "m", attempt: 1, error: "retry" });
		emit({ type: "model.request.started", sessionId: "s", taskId: "t", requestId: 2, timestamp, provider: "p", model: "m", attempt: 2 });
		emit({ type: "model.request.completed", sessionId: "s", taskId: "t", requestId: 2, timestamp, provider: "p", model: "m", inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1 });
		emit({ type: "tool.call.started", sessionId: "s", taskId: "t", callId: 1, timestamp, tool: "bash", source: "harnez" });
		emit({ type: "tool.call.started", sessionId: "s", taskId: "t", callId: 2, timestamp, tool: "read", source: "harnez" });
		emit({ type: "tool.call.completed", sessionId: "s", taskId: "t", callId: 1, timestamp, tool: "bash", source: "harnez", durationMs: 12 });
		emit({ type: "tool.call.failed", sessionId: "s", taskId: "t", callId: 2, timestamp, tool: "read", source: "harnez", error: "cancelled" });
		emit({ type: "context.assembly.completed", sessionId: "s", taskId: "t", assemblyId: 1, timestamp, trigger: "shrink", scope: "task", tokensBefore: 100, tokensAfter: 80, budget: 90, target: 70, liveTokens: 80, historyTokens: 20, pressureStreak: 2, agentContinued: true });
		emit({ type: "context.compaction.completed", sessionId: "s", taskId: "t", assemblyId: 1, timestamp, trigger: "automatic" });
		emit({ type: "task.completed", sessionId: "s", taskId: "t", timestamp });
		emit({ type: "session.completed", sessionId: "s", timestamp });
		await telemetry.shutdown();

		const byName = (name: string) => spans.filter((span) => span["name"] === name);
		expect(byName("harnez.session")).toHaveLength(1);
		expect(byName("invoke_agent")).toHaveLength(1);
		expect(byName("chat m")).toHaveLength(2);
		expect(byName("execute_tool bash")).toHaveLength(1);
		expect(byName("execute_tool read")).toHaveLength(1);
		expect(byName("harnez.context.assembly")).toHaveLength(1);
		expect(byName("harnez.context.compaction")).toHaveLength(1);
		const session = byName("harnez.session")[0]!;
		const task = byName("invoke_agent")[0]!;
		expect((task as { parentSpanContext?: { spanId: string } }).parentSpanContext?.spanId).toBe((session as { spanContext: () => { spanId: string } }).spanContext().spanId);
		expect((byName("chat m")[0]!["status"] as { code?: number }).code).toBe(2);
		expect(metricBatches.length).toBeGreaterThan(0);
		const metricNames = metricBatches.flatMap((batch) => ((batch as { scopeMetrics?: Array<{ metrics?: Array<{ descriptor?: { name?: string } }> }> }).scopeMetrics ?? []).flatMap((scope) => (scope.metrics ?? []).map((metric) => metric.descriptor?.name)));
		expect(metricNames).toEqual(expect.arrayContaining(["harnez.model.requests", "harnez.model.tokens", "harnez.tool.calls", "harnez.tool.duration", "harnez.context.assemblies", "harnez.context.compactions", "harnez.context.pressure_streak"]));
	});
});
