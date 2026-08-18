import { context, metrics, trace, type Span } from "@opentelemetry/api";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";

import type { RuntimeEvent, RuntimeEventSink } from "./events";

export type OpenTelemetryRuntime = {
	sink: RuntimeEventSink;
	shutdown: () => Promise<void>;
};

/** Starts no SDK, creates no exporter, and returns a no-op sink unless opted in. */
export function startOpenTelemetry(): OpenTelemetryRuntime {
	if (process.env["HARNEZ_OTEL"] !== "1")
		return { sink: () => {}, shutdown: async () => {} };
	const sdk = new NodeSDK({
		traceExporter: new OTLPTraceExporter(),
		metricReader: new PeriodicExportingMetricReader({
			exporter: new OTLPMetricExporter(),
		}),
	});
	void sdk.start();
	const tracer = trace.getTracer("harnez");
	const meter = metrics.getMeter("harnez");
	const modelRequests = meter.createCounter("harnez.model.requests");
	const toolCalls = meter.createCounter("harnez.tool.calls");
	const assemblies = meter.createCounter("harnez.context.assemblies");
	const compactions = meter.createCounter("harnez.context.compactions");
	const spans = new Map<string, Span>();
	const sink: RuntimeEventSink = (event: RuntimeEvent) => {
		if (event.type.startsWith("model.request."))
			modelRequests.add(1, {
				status: event.type.split(".").pop() ?? "unknown",
				provider: String(event["provider"] ?? "unknown"),
				model: String(event["model"] ?? "unknown"),
			});
		if (event.type.startsWith("tool.call."))
			toolCalls.add(1, {
				status: event.type.split(".").pop() ?? "unknown",
				tool: String(event["tool"] ?? "unknown"),
			});
		if (event.type === "context.assembly.completed")
			assemblies.add(1, {
				trigger: String(event["trigger"] ?? "unknown"),
				outcome: "completed",
			});
		if (event.type === "context.compaction.completed")
			compactions.add(1, { trigger: String(event["trigger"] ?? "automatic") });
		const key = `${event.sessionId}:${String(event.taskId ?? "")}`;
		const terminal = /\.(completed|failed)$/.test(event.type);
		if (!terminal) {
			const span = tracer.startSpan(event.type, undefined, context.active());
			for (const [name, value] of Object.entries(event))
				if (
					name !== "timestamp" &&
					(typeof value === "string" ||
						typeof value === "number" ||
						typeof value === "boolean")
				)
					span.setAttribute(`harnez.${name}`, value);
			spans.set(`${key}:${event.type.split(".").slice(0, -1).join(".")}`, span);
			if (!event.type.includes("started")) span.end();
			return;
		}
		const base = event.type.split(".").slice(0, -1).join(".");
		const span = spans.get(`${key}:${base}`);
		if (span) {
			for (const [name, value] of Object.entries(event))
				if (
					name !== "timestamp" &&
					(typeof value === "string" ||
						typeof value === "number" ||
						typeof value === "boolean")
				)
					span.setAttribute(`harnez.${name}`, value);
			span.end();
			spans.delete(`${key}:${base}`);
		}
	};
	return { sink, shutdown: () => sdk.shutdown() };
}
