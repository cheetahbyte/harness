import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	captureContent,
	captureMaxChars,
	sanitizedChildEnvironment,
	RuntimeTelemetry,
	sanitizeEvent,
	telemetryPrefixAlias,
} from "../src/telemetry/runtime";
import { startOpenTelemetry } from "../src/telemetry/opentelemetry";
import { SessionStore } from "../src/sessions/store";

describe("telemetry configuration", () => {
	test("parses capture categories and rejects unknown values", () => {
		expect([...captureContent("prompts, paths")]).toEqual(["prompts", "paths"]);
		expect([...captureContent("all")]).toEqual([
			"prompts",
			"responses",
			"tool-arguments",
			"tool-results",
			"mcp-payloads",
			"paths",
		]);
		expect(() => captureContent("secrets")).toThrow("unknown");
	});

	test("validates the capture value limit", () => {
		expect(captureMaxChars(undefined)).toBe(16_384);
		expect(captureMaxChars("64")).toBe(64);
		for (const value of ["0", "1.5", "wat", "1000001"])
			expect(() => captureMaxChars(value)).toThrow(
				"HARNEZ_OTEL_CAPTURE_MAX_CHARS",
			);
	});

	test("removes telemetry configuration from children", () => {
		const env = sanitizedChildEnvironment({ PATH: "/bin", OTEL_EXPORTER_OTLP_ENDPOINT: "secret", HARNEZ_OTEL: "1", HARNEZ_OTEL_CAPTURE_CONTENT: "prompts", HARNEZ_OTEL_CAPTURE_MAX_CHARS: "64", OTHER: "kept" });
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

	test("aliases prefix identity without exporting the fingerprint", () => {
		const key = new Uint8Array(32).fill(7);
		const first = telemetryPrefixAlias({ messages: ["secret"], model: "m" }, key);
		expect(first).toMatch(/^[0-9a-f]{24}$/);
		expect(first).not.toContain("secret");
		expect(telemetryPrefixAlias({ messages: ["secret"], model: "m" }, key)).toBe(first);
		expect(telemetryPrefixAlias({ messages: ["changed"], model: "m" }, key)).not.toBe(first);
	});

	test("keeps aliases stable across store reopen and changes with prefix inputs", () => {
		const directory = mkdtempSync(join(tmpdir(), "harnez-telemetry-"));
		const path = join(directory, "session.sqlite");
		const firstStore = new SessionStore(path);
		const key = firstStore.telemetryInstallKey();
		const base = {
			provider: "local",
			model: "coder",
			serializerVersion: "context-v1",
			system: "rules",
			fixed: ["capability"],
			tools: [{ name: "read", parameters: { type: "object" } }],
			messages: [{ role: "user", content: "hello" }],
		};
		const alias = telemetryPrefixAlias(base, key);
		for (const field of ["system", "fixed", "tools", "messages", "provider", "model"] as const) {
			const changed = { ...base, [field]: `${String(base[field])}-changed` };
			expect(telemetryPrefixAlias(changed, key)).not.toBe(alias);
		}
		firstStore.db.close();
		const reopened = new SessionStore(path);
		expect(telemetryPrefixAlias(base, reopened.telemetryInstallKey())).toBe(alias);
		reopened.db.close();
		rmSync(directory, { recursive: true, force: true });
	});

	test("recursively sanitizes and serializes captured payloads", () => {
		const cyclic: Record<string, unknown> = {
			text: "inspect /Users/alice/project, /workspace, file:///tmp/x; keep https://example.com/path",
			authorization: "Bearer private",
			privateKey: "PRIVATE",
			accessKeyId: "AKIA-PRIVATE",
			nested: {
				apiKey: "do-not-export",
				envVars: { HOME: "/Users/alice", TOKEN: "secret" },
				image: { type: "image", mimeType: "image/png", data: "base64bytes" },
				imageUrl: "data:image/png;base64,also-private",
				attachment:
					"data:application/octet-stream;base64,binary-attachment",
				buffer: { type: "Buffer", data: [1, 2, 3] },
				file: { data: "AAECAwQFBgcICQoLDA0ODw==" },
				apiEnvelope: { data: "human-readable result" },
			},
		};
		cyclic["self"] = cyclic;
		const event = sanitizeEvent(
			{
				type: "model.request.started",
				timestamp: "now",
				sessionId: "s",
				prompt: cyclic,
			},
			new Set(["prompts"]),
		);
		const payload = event["prompt"] as string;
		expect(() => JSON.parse(payload)).not.toThrow();
		expect(payload).toContain("[Path omitted]");
		expect(payload).toContain("[Circular]");
		expect(payload).toContain('"mimeType":"image/png"');
		expect(payload).not.toContain("private");
		expect(payload).not.toContain("do-not-export");
		expect(payload).not.toContain("AKIA-PRIVATE");
		expect(payload).not.toContain("base64bytes");
		expect(payload).not.toContain("also-private");
		expect(payload).not.toContain("binary-attachment");
		expect(payload).not.toContain("AAECAwQFBgcICQoLDA0ODw==");
		expect(payload).not.toContain("[1,2,3]");
		expect(payload).toContain("human-readable result");
		expect(payload).not.toContain('"envVars"');
		expect(payload).not.toContain("/workspace");
		expect(payload).not.toContain("file:///tmp/x");
		expect(payload).toContain("https://example.com/path");

		const withPaths = sanitizeEvent(
			{
				type: "model.request.started",
				timestamp: "now",
				sessionId: "s",
				prompt: { path: "/Users/alice/project" },
			},
			new Set(["prompts", "paths"]),
		);
		expect(withPaths["prompt"]).toContain("/Users/alice/project");
	});

	test("bounds captured payload strings with a visible truncation marker", () => {
		const event = sanitizeEvent(
			{
				type: "model.request.completed",
				timestamp: "now",
				sessionId: "s",
				response: "x".repeat(200),
			},
			new Set(["responses"]),
			64,
		);
		expect(String(event["response"]).length).toBeLessThanOrEqual(64);
		expect(event["response"]).toContain("originalChars=200");
	});

	test("does not export condensation milestone text by default", () => {
		const event = sanitizeEvent({
			type: "context.compaction.completed",
			timestamp: "now",
			sessionId: "s",
			milestone: "private project summary",
		});
		expect(event["milestone"]).toBeUndefined();
	});

	test("redacts sensitive fields for every lifecycle event kind", () => {
		const types = ["session.started", "task.started", "turn.started", "model.request.started", "model.request.completed", "model.request.failed", "tool.call.started", "tool.call.completed", "tool.call.failed", "skill.discovered", "skill.inspected", "skill.activated", "capability.snapshot.created", "context.assembly.completed", "context.assembly.failed", "context.prepare", "context.compaction.started", "context.compaction.completed", "context.compaction.failed", "context.recovery.completed", "approval.requested", "approval.resolved", "subagent.started", "subagent.completed", "subagent.failed"] as const;
		for (const type of types) {
			const event = sanitizeEvent({ type, timestamp: "now", sessionId: "s", prompt: "secret prompt", response: "secret response", toolArguments: "args", toolResults: "result", mcpPayload: "payload", imageBytes: new Uint8Array([1]), authorization: "Bearer key", path: "/Users/private/file" });
			expect(event["prompt"]).toBeUndefined();
			expect(event["response"]).toBeUndefined();
			expect(event["authorization"]).toBeUndefined();
			expect(event["imageBytes"]).toBeUndefined();
			expect(event["messages"]).toBeUndefined();
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
		const previousCapture = process.env["HARNEZ_OTEL_CAPTURE_CONTENT"];
		process.env["HARNEZ_OTEL_CAPTURE_CONTENT"] = "prompts,responses";
		const telemetry = startOpenTelemetry({
			enabled: true,
			traceExporter,
			metricExporter,
		});
		if (previousCapture === undefined)
			delete process.env["HARNEZ_OTEL_CAPTURE_CONTENT"];
		else process.env["HARNEZ_OTEL_CAPTURE_CONTENT"] = previousCapture;
		const emit = telemetry.sink;
		const timestamp = new Date().toISOString();
		emit({ type: "session.started", sessionId: "s", timestamp });
		emit({ type: "task.started", sessionId: "s", taskId: "t", timestamp });
		emit({ type: "model.request.started", sessionId: "s", taskId: "t", requestId: 1, timestamp, provider: "p", model: "m", attempt: 1 });
		emit({ type: "model.request.failed", sessionId: "s", taskId: "t", requestId: 1, timestamp, provider: "p", model: "m", attempt: 1, error: "retry" });
		emit({ type: "model.request.started", sessionId: "s", taskId: "t", requestId: 2, timestamp, provider: "p", model: "m", attempt: 2, prompt: [{ role: "user", content: "question" }] });
		emit({ type: "model.request.completed", sessionId: "s", taskId: "t", requestId: 2, timestamp, provider: "p", model: "m", inputTokens: 10, outputTokens: 4, cacheReadTokens: 2, cacheWriteTokens: 1, response: { role: "assistant", content: "answer" } });
		emit({ type: "tool.call.started", sessionId: "s", taskId: "t", callId: 1, timestamp, tool: "bash", source: "harnez" });
		emit({ type: "tool.call.started", sessionId: "s", taskId: "t", callId: 2, timestamp, tool: "read", source: "harnez" });
		emit({ type: "tool.call.completed", sessionId: "s", taskId: "t", callId: 1, timestamp, tool: "bash", source: "harnez", durationMs: 12 });
		emit({ type: "tool.call.failed", sessionId: "s", taskId: "t", callId: 2, timestamp, tool: "read", source: "harnez", error: "cancelled" });
		emit({ type: "context.assembly.completed", sessionId: "s", taskId: "t", assemblyId: 1, timestamp, trigger: "shrink", scope: "task", tokensBefore: 100, tokensAfter: 80, budget: 90, target: 70, liveTokens: 80, historyTokens: 20, pressureStreak: 2, agentContinued: true });
		emit({ type: "context.compaction.completed", sessionId: "s", taskId: "t", assemblyId: 1, timestamp, trigger: "explicit", milestone: "tests" });
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
		const completedChat = byName("chat m")[1]! as {
			attributes?: Record<string, unknown>;
		};
		expect(completedChat.attributes?.["gen_ai.input.messages"]).toContain(
			"question",
		);
		expect(completedChat.attributes?.["gen_ai.output.messages"]).toContain(
			"answer",
		);
		expect(completedChat.attributes?.["harnez.prompt"]).toBeUndefined();
		expect(metricBatches.length).toBeGreaterThan(0);
		const metricNames = metricBatches.flatMap((batch) => ((batch as { scopeMetrics?: Array<{ metrics?: Array<{ descriptor?: { name?: string } }> }> }).scopeMetrics ?? []).flatMap((scope) => (scope.metrics ?? []).map((metric) => metric.descriptor?.name)));
		expect(metricNames).toEqual(expect.arrayContaining(["harnez.model.requests", "harnez.model.tokens", "harnez.tool.calls", "harnez.tool.duration", "harnez.context.assemblies", "harnez.context.compactions", "harnez.context.pressure_streak"]));
	});
});
