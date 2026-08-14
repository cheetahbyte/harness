import { Type } from "@earendil-works/pi-ai";

import type { ToolCapabilityInput } from "../capabilities/types";
import type { McpToolDescriptor } from "./registry";

/** Provider ids are namespaced per server so one server can be disabled alone. */
export const MCP_PROVIDER_PREFIX = "mcp:";

export function isMcpProvider(providerId: string): boolean {
	return providerId.startsWith(MCP_PROVIDER_PREFIX);
}

/**
 * `CapabilityCatalog` bounds metadata and throws on empty or oversized strings,
 * so text coming from a server is clamped here rather than being allowed to
 * abort catalog construction for every other capability.
 */
const MAX_DESCRIPTION = 2_000;
const MAX_DISPLAY_NAME = 200;

export function mcpCapabilities(
	tools: readonly McpToolDescriptor[],
	bindingGeneration: string,
): ToolCapabilityInput[] {
	return tools.map((tool) => ({
		kind: "tool",
		id: `tool:${tool.name}`,
		name: tool.name,
		description: describe(tool),
		/**
		 * The operator wrote `mcp.json`, which is the same trust basis as a skill
		 * file. `provider_untrusted` would blank the description and hide the tool
		 * from discovery entirely, making it unreachable.
		 */
		metadataTrust: "operator_approved",
		providerDisplayName: clamp(
			`MCP server ${tool.server}`,
			MAX_DISPLAY_NAME,
			"MCP server",
		),
		providerBinding: {
			providerId: `${MCP_PROVIDER_PREFIX}${tool.server}`,
			bindingGeneration,
		},
		schema: schemaOf(tool),
		// `readOnlyHint` is advisory, so anything unhinted is treated as mutating.
		effect: tool.readOnly ? "read_only" : "mutating",
	}));
}

function describe(tool: McpToolDescriptor): string {
	return clamp(
		tool.description.trim(),
		MAX_DESCRIPTION,
		`The ${tool.tool} tool provided by the ${tool.server} MCP server.`,
	);
}

function clamp(value: string, max: number, fallback: string): string {
	if (!value.trim()) return fallback.slice(0, max);
	return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * MCP input schemas are JSON Schema, which the agent layer accepts structurally.
 * A server that advertises something else still gets a usable, empty contract.
 */
function schemaOf(tool: McpToolDescriptor): unknown {
	const schema = tool.inputSchema;
	return typeof schema === "object" && schema !== null && !Array.isArray(schema)
		? schema
		: Type.Object({});
}
