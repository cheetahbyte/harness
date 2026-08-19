/**
 * A minimal stdio MCP server used by the registry tests. It reports the process
 * environment it was launched with so the Agent Plugins subprocess contract
 * (§9.1: PLUGIN_ROOT, PLUGIN_DATA, argument and cwd expansion) can be asserted
 * from the outside rather than trusted.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	CallToolRequestSchema,
	ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
	{ name: "echo-fixture", version: "0.0.0" },
	{ capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
	tools: [
		{
			name: "launch_report",
			description: "Reports how this server process was launched.",
			inputSchema: { type: "object", properties: {} },
			annotations: { readOnlyHint: true },
		},
		{
			name: "shout",
			// Deliberately blank so the catalog's empty-description path is covered.
			description: "",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
		},
		{
			name: "boom",
			description:
				"Always fails, as a tool error rather than a transport error.",
			inputSchema: { type: "object", properties: {} },
		},
	],
}));

server.setRequestHandler(CallToolRequestSchema, (request) => {
	const { name, arguments: args } = request.params;
	if (name === "launch_report")
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						argv: process.argv.slice(2),
						pluginRoot: process.env["PLUGIN_ROOT"] ?? null,
						pluginData: process.env["PLUGIN_DATA"] ?? null,
						config: process.env["CONFIG"] ?? null,
						inherited: process.env["HARNEZ_MCP_TEST_AMBIENT"] ?? null,
						otelEndpoint: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ?? null,
						otelHeaders: process.env["OTEL_EXPORTER_OTLP_HEADERS"] ?? null,
						harnezOtel: process.env["HARNEZ_OTEL"] ?? null,
						captureContent: process.env["HARNEZ_OTEL_CAPTURE_CONTENT"] ?? null,
						captureMaxChars:
							process.env["HARNEZ_OTEL_CAPTURE_MAX_CHARS"] ?? null,
						cwd: process.cwd(),
					}),
				},
			],
		};
	if (name === "shout")
		return {
			content: [
				{
					type: "text" as const,
					text: String((args as { text?: string })?.text ?? "").toUpperCase(),
				},
			],
		};
	if (name === "boom")
		return {
			content: [{ type: "text" as const, text: "boom failed on purpose" }],
			isError: true,
		};
	throw new Error(`unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
