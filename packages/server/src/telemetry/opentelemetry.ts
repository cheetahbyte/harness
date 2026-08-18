import {
	context,
	metrics,
	SpanStatusCode,
	trace,
	type Span,
	type Context,
} from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

import type { RuntimeEvent, RuntimeEventSink } from "./events";
import { captureContent, sanitizeEvent } from "./runtime";

const eventAttributes = (
	event: RuntimeEvent,
): Record<string, string | number | boolean> =>
	Object.fromEntries(
		Object.entries(event)
			.filter(
				([key, value]) =>
					key !== "timestamp" &&
					typeof value !== "object" &&
					(typeof value === "string" ||
						typeof value === "number" ||
						typeof value === "boolean"),
			)
			.map(([key, value]) => [
				`harnez.${key}`,
				value as string | number | boolean,
			]),
	);

export type OpenTelemetryRuntime = {
	sink: RuntimeEventSink;
	shutdown: () => Promise<void>;
};

export type OpenTelemetryOptions = {
	enabled?: boolean;
	/** Exporter overrides are intended for in-memory verification. */
	traceExporter?: unknown;
	metricExporter?: unknown;
};

/** Starts the SDK only when opted in; exporter selection remains OTEL_* controlled. */
export function startOpenTelemetry(
	options: OpenTelemetryOptions = {},
): OpenTelemetryRuntime {
	if (options.enabled ?? process.env["HARNEZ_OTEL"] === "1")
		return startEnabledOpenTelemetry(options);
	return { sink: () => {}, shutdown: async () => {} };
}

function startEnabledOpenTelemetry(
	options: OpenTelemetryOptions,
): OpenTelemetryRuntime {
	const traceExporter =
		options.traceExporter ??
		(process.env["OTEL_TRACES_EXPORTER"] === "otlp"
			? new OTLPTraceExporter()
			: undefined);
	const metricExporter =
		options.metricExporter ??
		(process.env["OTEL_METRICS_EXPORTER"] === "otlp"
			? new OTLPMetricExporter()
			: undefined);
	if (!traceExporter && !metricExporter)
		return { sink: () => {}, shutdown: async () => {} };
	const sdk = new NodeSDK({
		...(traceExporter ? { traceExporter: traceExporter as never } : {}),
		...(metricExporter
			? {
					metricReader: new PeriodicExportingMetricReader({
						exporter: metricExporter as never,
					}),
				}
			: {}),
	});
	void sdk.start();
	const tracer = trace.getTracer("harnez"),
		meter = metrics.getMeter("harnez");
	const modelRequests = meter.createCounter("harnez.model.requests");
	const modelTokens = meter.createCounter("harnez.model.tokens");
	const toolCalls = meter.createCounter("harnez.tool.calls");
	const toolDuration = meter.createHistogram("harnez.tool.duration", {
		unit: "ms",
	});
	const assemblies = meter.createCounter("harnez.context.assemblies");
	const compactions = meter.createCounter("harnez.context.compactions");
	const liveTokens = meter.createHistogram("harnez.context.live_tokens");
	const historyTokens = meter.createHistogram("harnez.context.history_tokens");
	const pressureStreak = meter.createHistogram(
		"harnez.context.pressure_streak",
	);
	const spans = new Map<string, { span: Span; ctx: Context }>();
	const capture = captureContent();
	const parent = (event: RuntimeEvent): Context =>
		spans.get(`${event.sessionId}:task:${event.taskId}`)?.ctx ??
		spans.get(`${event.sessionId}:session`)?.ctx ??
		context.active();
	const start = (
		key: string,
		name: string,
		event: RuntimeEvent,
		parentCtx: Context,
	): void => {
		const span = tracer.startSpan(
			name,
			{ attributes: eventAttributes(event) },
			parentCtx,
		);
		spans.set(key, { span, ctx: trace.setSpan(parentCtx, span) });
	};
	const finish = (key: string, event: RuntimeEvent): void => {
		const entry = spans.get(key);
		if (!entry) return;
		entry.span.setAttributes(eventAttributes(event));
		if (event.type.endsWith("failed")) {
			entry.span.setStatus({ code: SpanStatusCode.ERROR });
			if (typeof event.error === "string")
				entry.span.recordException(event.error);
		}
		entry.span.end();
		spans.delete(key);
	};
	const oneShot = (name: string, event: RuntimeEvent): void => {
		const span = tracer.startSpan(
			name,
			{ attributes: eventAttributes(event) },
			parent(event),
		);
		if (event.type.endsWith("failed"))
			span.setStatus({ code: SpanStatusCode.ERROR });
		span.end();
	};
	const sink: RuntimeEventSink = (raw) => {
		const event = sanitizeEvent(raw, capture);
		const base = event.type.replace(/\.(started|completed|failed)$/, "");
		const key = `${event.sessionId}:${event.taskId ?? ""}:${base}:${event.requestId ?? event.callId ?? event.approvalId ?? event.turnId ?? ""}`;
		if (event.type === "session.started")
			start(
				`${event.sessionId}:session`,
				"harnez.session",
				event,
				context.active(),
			);
		else if (event.type === "session.completed")
			finish(`${event.sessionId}:session`, event);
		else if (event.type === "task.started")
			start(
				`${event.sessionId}:task:${event.taskId}`,
				"invoke_agent",
				event,
				parent(event),
			);
		else if (event.type === "task.completed")
			finish(`${event.sessionId}:task:${event.taskId}`, event);
		else if (event.type.endsWith(".started"))
			start(
				key,
				base === "model.request"
					? `chat ${String(event.model ?? "unknown")}`
					: base === "tool.call"
						? `execute_tool ${String(event.tool ?? "unknown")}`
						: `harnez.${base}`,
				event,
				parent(event),
			);
		else if (
			(event.type.endsWith(".completed") || event.type.endsWith(".failed")) &&
			!event.type.startsWith("context.assembly.") &&
			!event.type.startsWith("skill.") &&
			event.type !== "capability.snapshot.created" &&
			!event.type.startsWith("approval.") &&
			!event.type.startsWith("subagent.")
		)
			finish(key, event);
		else if (event.type.startsWith("context.assembly."))
			oneShot("harnez.context.assembly", event);
		else if (
			event.type.startsWith("skill.") ||
			event.type === "capability.snapshot.created" ||
			event.type.startsWith("approval.") ||
			event.type.startsWith("subagent.")
		)
			oneShot(`harnez.${event.type}`, event);
		if (event.type === "context.compaction.completed") {
			const span = tracer.startSpan(
				"harnez.context.compaction",
				{ attributes: eventAttributes(event) },
				parent(event),
			);
			span.end();
		}
		if (
			event.type === "model.request.completed" ||
			event.type === "model.request.failed"
		)
			modelRequests.add(1, {
				provider: String(event.provider ?? "unknown"),
				model: String(event.model ?? "unknown"),
				status: event.type.split(".").pop() ?? "unknown",
			});
		if (
			event.type === "model.request.completed" &&
			typeof event.inputTokens === "number"
		)
			modelTokens.add(event.inputTokens, {
				provider: String(event.provider ?? "unknown"),
				model: String(event.model ?? "unknown"),
				kind: "input",
			});
		if (
			event.type === "model.request.completed" &&
			typeof event.outputTokens === "number"
		)
			modelTokens.add(event.outputTokens, {
				provider: String(event.provider ?? "unknown"),
				model: String(event.model ?? "unknown"),
				kind: "output",
			});
		if (
			event.type === "model.request.completed" &&
			typeof event["cacheReadTokens"] === "number"
		)
			modelTokens.add(event["cacheReadTokens"] as number, {
				provider: String(event.provider ?? "unknown"),
				model: String(event.model ?? "unknown"),
				kind: "cache_read",
			});
		if (
			event.type === "model.request.completed" &&
			typeof event["cacheWriteTokens"] === "number"
		)
			modelTokens.add(event["cacheWriteTokens"] as number, {
				provider: String(event.provider ?? "unknown"),
				model: String(event.model ?? "unknown"),
				kind: "cache_write",
			});
		if (
			event.type === "tool.call.completed" ||
			event.type === "tool.call.failed"
		)
			toolCalls.add(1, {
				tool: String(event.tool ?? "unknown"),
				source: String(event.source ?? "unknown"),
				status: event.type.split(".").pop() ?? "unknown",
			});
		if (
			event.type === "tool.call.completed" &&
			typeof event.durationMs === "number"
		)
			toolDuration.record(event.durationMs, {
				tool: String(event.tool ?? "unknown"),
				source: String(event.source ?? "unknown"),
			});
		if (event.type === "context.assembly.completed") {
			assemblies.add(1, {
				trigger: String(event.trigger ?? "unknown"),
				outcome: "completed",
			});
			if (typeof event.liveTokens === "number")
				liveTokens.record(event.liveTokens);
			if (typeof event.historyTokens === "number")
				historyTokens.record(event.historyTokens);
			if (typeof event.pressureStreak === "number")
				pressureStreak.record(event.pressureStreak);
		}
		if (event.type === "context.compaction.completed")
			compactions.add(1, { trigger: String(event.trigger ?? "automatic") });
	};
	return { sink, shutdown: () => sdk.shutdown() };
}
