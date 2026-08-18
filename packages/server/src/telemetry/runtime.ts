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
		if (this.enabled) this.sink(sanitizeEvent(event, this.capture));
	}
}

const secret =
	/(api[-_ ]?key|token|secret|password|authorization|credential|cookie)/i;
const sensitive =
	/(image|binary|credential|authorization|bearer|private[_-]?key|access[_-]?key|refresh[_-]?token)/i;
const pathLike = /(^|\/|\\)(?:Users|home|private|tmp|var|etc)(?:\/|\\)/i;

/** Keep lifecycle metadata useful while making accidental payload leakage hard. */
export function sanitizeEvent(
	event: RuntimeEvent,
	capture: ReadonlySet<CaptureContent> = new Set(),
): RuntimeEvent {
	const result: RuntimeEvent = { ...event };
	for (const key of Object.keys(result)) {
		if (
			key === "timestamp" ||
			key === "type" ||
			key === "sessionId" ||
			key.endsWith("Id")
		)
			continue;
		const value = result[key];
		if (
			((sensitive.test(key) || secret.test(key)) &&
				typeof value !== "number") ||
			value instanceof Uint8Array ||
			(typeof value === "string" &&
				(secret.test(value) || /^data:image\//i.test(value)))
		) {
			delete result[key];
			continue;
		}
		if (key.toLowerCase().includes("path") && !capture.has("paths"))
			delete result[key];
		if (
			[
				"prompt",
				"response",
				"toolArguments",
				"toolResults",
				"mcpPayload",
				"input",
				"output",
				"content",
			].some((part) => key.toLowerCase().includes(part))
		) {
			const category = key.toLowerCase().includes("prompt")
				? "prompts"
				: key.toLowerCase().includes("response")
					? "responses"
					: key.toLowerCase().includes("argument") || key === "input"
						? "tool-arguments"
						: key.toLowerCase().includes("result") || key === "output"
							? "tool-results"
							: "mcp-payloads";
			if (!capture.has(category as CaptureContent)) delete result[key];
		}
		if (
			typeof result[key] === "string" &&
			pathLike.test(result[key] as string) &&
			!capture.has("paths")
		)
			delete result[key];
	}
	return result;
}
