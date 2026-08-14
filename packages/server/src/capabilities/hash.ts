import { createHash } from "node:crypto";

export function rawHash(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function structuredHash(value: unknown): string {
	return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "boolean" || typeof value === "string")
		return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value))
			throw new Error("canonical JSON requires finite numbers");
		return JSON.stringify(value);
	}
	if (Array.isArray(value))
		return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		const entries = Object.keys(record)
			.toSorted()
			.map((key) => {
				const item = record[key];
				if (item === undefined)
					throw new Error("canonical JSON does not support undefined");
				return `${JSON.stringify(key)}:${canonicalJson(item)}`;
			});
		return `{${entries.join(",")}}`;
	}
	throw new Error(`canonical JSON does not support ${typeof value}`);
}
