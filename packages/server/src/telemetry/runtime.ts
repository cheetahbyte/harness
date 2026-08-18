import {
	noopRuntimeEventSink,
	type RuntimeEvent,
	type RuntimeEventSink,
} from "./events";

export type CaptureContent =
	| "prompts"
	| "responses"
	| "tool-arguments"
	| "tool-results"
	| "mcp-payloads"
	| "paths";
const captureValues = new Set<CaptureContent>([
	"prompts",
	"responses",
	"tool-arguments",
	"tool-results",
	"mcp-payloads",
	"paths",
]);
const childExcluded = /^(?:OTEL_|HARNEZ_OTEL$|HARNEZ_OTEL_CAPTURE_CONTENT$)/;

export function captureContent(
	value = process.env["HARNEZ_OTEL_CAPTURE_CONTENT"],
): ReadonlySet<CaptureContent> {
	if (!value) return new Set();
	const result = new Set<CaptureContent>();
	for (const item of value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)) {
		if (!captureValues.has(item as CaptureContent))
			throw new Error(`unknown HARNEZ_OTEL_CAPTURE_CONTENT value: ${item}`);
		result.add(item as CaptureContent);
	}
	return result;
}

/** Prevent telemetry configuration and correlation state leaking into children. */
export function sanitizedChildEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	return Object.fromEntries(
		Object.entries(environment).filter(
			([key, value]) => value !== undefined && !childExcluded.test(key),
		),
	) as Record<string, string>;
}

export class RuntimeTelemetry {
	readonly enabled: boolean;
	readonly capture: ReadonlySet<CaptureContent>;
	private readonly sink: RuntimeEventSink;

	constructor(
		options: {
			sink?: RuntimeEventSink;
			enabled?: boolean;
			capture?: string;
		} = {},
	) {
		this.enabled = options.enabled ?? process.env["HARNEZ_OTEL"] === "1";
		this.capture = captureContent(
			options.capture ?? process.env["HARNEZ_OTEL_CAPTURE_CONTENT"],
		);
		this.sink = this.enabled
			? (options.sink ?? noopRuntimeEventSink)
			: noopRuntimeEventSink;
	}

	emit(event: RuntimeEvent): void {
		if (this.enabled) this.sink(event);
	}
}
