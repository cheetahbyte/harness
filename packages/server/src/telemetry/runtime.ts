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
const allCaptureContent = [
	"prompts",
	"responses",
	"tool-arguments",
	"tool-results",
	"mcp-payloads",
	"paths",
] as const satisfies readonly CaptureContent[];
const captureValues = new Set<CaptureContent>(allCaptureContent);
const childExcluded =
	/^(?:OTEL_|HARNEZ_OTEL$|HARNEZ_OTEL_CAPTURE_(?:CONTENT|MAX_CHARS)$)/;
const DEFAULT_CAPTURE_MAX_CHARS = 16_384;
const MAX_CAPTURE_CHARS = 1_000_000;

export function captureContent(
	value = process.env["HARNEZ_OTEL_CAPTURE_CONTENT"],
): ReadonlySet<CaptureContent> {
	if (!value) return new Set();
	const result = new Set<CaptureContent>();
	for (const item of value
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)) {
		if (item === "all") {
			for (const category of allCaptureContent) result.add(category);
			continue;
		}
		if (!captureValues.has(item as CaptureContent))
			throw new Error(`unknown HARNEZ_OTEL_CAPTURE_CONTENT value: ${item}`);
		result.add(item as CaptureContent);
	}
	return result;
}

export function captureMaxChars(
	value = process.env["HARNEZ_OTEL_CAPTURE_MAX_CHARS"],
): number {
	if (value === undefined || value === "") return DEFAULT_CAPTURE_MAX_CHARS;
	if (!/^[1-9]\d*$/.test(value))
		throw new Error("HARNEZ_OTEL_CAPTURE_MAX_CHARS must be a positive integer");
	const result = Number(value);
	if (!Number.isSafeInteger(result) || result > MAX_CAPTURE_CHARS)
		throw new Error(
			`HARNEZ_OTEL_CAPTURE_MAX_CHARS must be at most ${MAX_CAPTURE_CHARS}`,
		);
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
	readonly maxChars: number;
	private readonly sink: RuntimeEventSink;

	constructor(
		options: {
			sink?: RuntimeEventSink;
			enabled?: boolean;
			capture?: string;
			maxChars?: string;
		} = {},
	) {
		this.enabled = options.enabled ?? process.env["HARNEZ_OTEL"] === "1";
		this.capture = captureContent(
			options.capture ?? process.env["HARNEZ_OTEL_CAPTURE_CONTENT"],
		);
		this.maxChars = captureMaxChars(
			options.maxChars ?? process.env["HARNEZ_OTEL_CAPTURE_MAX_CHARS"],
		);
		this.sink = this.enabled
			? (options.sink ?? noopRuntimeEventSink)
			: noopRuntimeEventSink;
	}

	emit(event: RuntimeEvent): void {
		if (this.enabled)
			this.sink(sanitizeEvent(event, this.capture, this.maxChars));
	}
}

const secretKey =
	/(api[-_ ]?key|token|secret|password|authorization|credential|cookie|private[-_ ]?key|access[-_ ]?key(?:id)?)/i;
const environmentKey =
	/^(?:(?:process)?env(?:ironment)?(?:variables)?|env(?:vars|map|variables)?|headers?)$/i;
const binaryKey =
	/(?:image|binary).*(?:data|bytes)|(?:data|bytes).*(?:image|binary)/i;
const dataKey = /^(?:data|bytes)$/i;
const absolutePath =
	/(?<![:/A-Za-z0-9])(?:[A-Za-z]:[\\/][^\s"'<>]+|\\\\[^\\\s"'<>]+\\[^\s"'<>]+|\/(?!\/)[^\s"'<>]+)/gi;
const fileUrl = /\bfile:\/\/\/[^\s"'<>]+/gi;
const privateKeyBlock =
	/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\n]*PRIVATE KEY-----/gi;
const bearerValue = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const secretAssignment =
	/\b(api[-_ ]?key|token|secret|password|authorization|cookie)\s*[:=]\s*([^\s,;]+)/gi;
const contentCategories: Record<string, CaptureContent> = {
	prompt: "prompts",
	response: "responses",
	toolarguments: "tool-arguments",
	toolresults: "tool-results",
	mcppayload: "mcp-payloads",
	input: "tool-arguments",
	output: "tool-results",
	content: "mcp-payloads",
};

function isBinaryData(
	key: string,
	value: unknown,
	container: Record<string, unknown>,
): boolean {
	if (!dataKey.test(key)) return false;
	if (
		container["type"] === "Buffer" ||
		container["type"] === "binary" ||
		container["type"] === "image" ||
		typeof container["mimeType"] === "string"
	)
		return true;
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return true;
	if (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
	)
		return true;
	return (
		typeof value === "string" &&
		(/^data:[^;,]+;base64,/i.test(value) ||
			(value.length >= 16 &&
				value.length % 4 === 0 &&
				/^[A-Za-z0-9+/]+={0,2}$/.test(value)))
	);
}

function sanitizeString(
	value: string,
	capture: ReadonlySet<CaptureContent>,
): string {
	if (/^data:image\//i.test(value)) return "[Image omitted]";
	if (/^data:[^;,]+;base64,/i.test(value)) return "[Binary omitted]";
	const withoutPaths = capture.has("paths")
		? value
		: value
				.replace(fileUrl, "[Path omitted]")
				.replace(absolutePath, "[Path omitted]");
	return withoutPaths
		.replace(privateKeyBlock, "[Private key omitted]")
		.replace(bearerValue, "Bearer [REDACTED]")
		.replace(secretAssignment, "$1=[REDACTED]");
}

function sanitizeValue(
	value: unknown,
	capture: ReadonlySet<CaptureContent>,
	ancestors: WeakSet<object>,
): unknown {
	if (value === null || typeof value === "number" || typeof value === "boolean")
		return value;
	if (typeof value === "string") return sanitizeString(value, capture);
	if (typeof value === "bigint") return String(value);
	if (typeof value !== "object") return undefined;
	if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer)
		return undefined;
	if (ancestors.has(value)) return "[Circular]";
	ancestors.add(value);
	if (Array.isArray(value)) {
		const result = value
			.map((item) => sanitizeValue(item, capture, ancestors))
			.filter((item) => item !== undefined);
		ancestors.delete(value);
		return result;
	}
	const source = value as Record<string, unknown>;
	const result: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(source)) {
		if (
			secretKey.test(key) ||
			environmentKey.test(key) ||
			binaryKey.test(key) ||
			isBinaryData(key, item, source) ||
			(key.toLowerCase().includes("path") && !capture.has("paths"))
		)
			continue;
		const sanitized = sanitizeValue(item, capture, ancestors);
		if (sanitized !== undefined) result[key] = sanitized;
	}
	ancestors.delete(value);
	return result;
}

function bounded(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	const marker = `… [truncated; originalChars=${value.length}]`;
	if (marker.length >= maxChars) return marker.slice(0, maxChars);
	return `${value.slice(0, maxChars - marker.length)}${marker}`;
}

function capturedValue(
	value: unknown,
	capture: ReadonlySet<CaptureContent>,
	maxChars: number,
): string | undefined {
	try {
		const sanitized = sanitizeValue(value, capture, new WeakSet());
		if (sanitized === undefined) return undefined;
		return bounded(
			typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized),
			maxChars,
		);
	} catch {
		return "[Unserializable payload omitted]";
	}
}

/** Keep lifecycle metadata useful while making accidental payload leakage hard. */
export function sanitizeEvent(
	event: RuntimeEvent,
	capture: ReadonlySet<CaptureContent> = new Set(),
	maxChars = DEFAULT_CAPTURE_MAX_CHARS,
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
			typeof value !== "number" &&
			(secretKey.test(key) || environmentKey.test(key) || binaryKey.test(key))
		) {
			delete result[key];
			continue;
		}
		const category = contentCategories[key.toLowerCase()];
		if (category) {
			if (!capture.has(category)) delete result[key];
			else {
				const sanitized = capturedValue(value, capture, maxChars);
				if (sanitized === undefined) delete result[key];
				else result[key] = sanitized;
			}
			continue;
		}
		if (key.toLowerCase().includes("path") && !capture.has("paths")) {
			delete result[key];
			continue;
		}
		if (typeof value === "string") result[key] = sanitizeString(value, capture);
	}
	return result;
}
