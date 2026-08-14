import { expect, test } from "bun:test";

import { CapabilityCatalog } from "../src/capabilities/catalog";
import { isMcpProvider, mcpCapabilities } from "../src/mcp/capabilities";
import type { McpToolDescriptor } from "../src/mcp/registry";

function descriptor(
	overrides: Partial<McpToolDescriptor> = {},
): McpToolDescriptor {
	return {
		server: "acme",
		tool: "search",
		name: "mcp__acme__search",
		description: "Searches the index.",
		inputSchema: { type: "object", properties: {} },
		readOnly: false,
		...overrides,
	};
}

/**
 * `CapabilityCatalog` rejects empty or oversized metadata by throwing, which
 * would take down every other capability in the same task. Server-authored text
 * is therefore clamped before it gets there.
 */
test("clamps server metadata the catalog would otherwise reject", () => {
	const generation = "binding-1";
	const capabilities = mcpCapabilities(
		[
			descriptor({ tool: "blank", name: "mcp__acme__blank", description: "   " }),
			descriptor({
				tool: "verbose",
				name: "mcp__acme__verbose",
				description: "x".repeat(5_000),
			}),
		],
		generation,
	);

	expect(capabilities[0]?.description).toBe(
		"The blank tool provided by the acme MCP server.",
	);
	expect(capabilities[1]?.description).toHaveLength(2_000);
	expect(() => new CapabilityCatalog(capabilities, generation)).not.toThrow();
});

test("falls back to an empty object schema when a server advertises none", () => {
	const [capability] = mcpCapabilities(
		[descriptor({ inputSchema: "not a schema" })],
		"binding-1",
	);
	expect(capability?.schema).toMatchObject({ type: "object" });
});

test("namespaces provider bindings so one server can be identified alone", () => {
	const [capability] = mcpCapabilities([descriptor()], "binding-1");
	expect(capability?.id).toBe("tool:mcp__acme__search");
	expect(capability?.providerBinding).toEqual({
		providerId: "mcp:acme",
		bindingGeneration: "binding-1",
	});
	expect(isMcpProvider("mcp:acme")).toBe(true);
	expect(isMcpProvider("workspace")).toBe(false);
	expect(isMcpProvider("harnez")).toBe(false);
});
