import type { MarkdownHeading } from "@tanstack/markdown";
import { docsMarkdownExtensions } from "@tanstack/markdown/extensions/docs";
import { renderHtml } from "@tanstack/markdown/html";
import { parseMarkdown } from "@tanstack/markdown/parser";
import architecture from "./architecture.md?raw";
import cliReference from "./cli-reference.md?raw";
import configuration from "./configuration.md?raw";
import contextCompaction from "./context-compaction.md?raw";
import { getFrontmatterSlug } from "./frontmatter";
import installation from "./installation.md?raw";
import introduction from "./introduction.md?raw";
import sessions from "./sessions.md?raw";
import skills from "./skills.md?raw";
import taskRuntime from "./task-runtime.md?raw";
import toolDiscovery from "./tool-discovery.md?raw";

export interface DocPage {
	slug: string;
	title: string;
	description: string;
	section: string;
	source: string;
	indexable?: boolean;
}

export const docSections = ["Guide", "Architecture", "Advanced"] as const;

export const docPages: DocPage[] = [
	{
		slug: getFrontmatterSlug(introduction),
		title: "Introduction",
		description:
			"Learn how Harnez runs model-agnostic coding agents with a local server, terminal UI, trusted execution, and bounded context.",
		section: "Guide",
		source: introduction,
	},
	{
		slug: getFrontmatterSlug(installation),
		title: "Installation",
		description:
			"Install Harnez from npm or source with Bun, verify the CLI, and continue to provider configuration.",
		section: "Guide",
		source: installation,
	},
	{
		slug: getFrontmatterSlug(architecture),
		title: "Architecture",
		description:
			"Understand Harnez's local client-server architecture, agent loop, subagents, context management, and tool discovery.",
		section: "Architecture",
		source: architecture,
	},
	{
		slug: getFrontmatterSlug(cliReference),
		title: "CLI reference",
		description:
			"Use Harnez commands and keyboard shortcuts to configure models, steer tasks, queue follow-ups, and control the terminal UI.",
		section: "Guide",
		source: cliReference,
	},
	{
		slug: getFrontmatterSlug(configuration),
		title: "Configuration",
		description:
			"Configure Harnez credentials, models, project overrides, environment variables, context budgets, and logging.",
		section: "Guide",
		source: configuration,
	},
	{
		slug: getFrontmatterSlug(contextCompaction),
		title: "Context compaction",
		description:
			"See how Harnez keeps long-running agents within a token budget using observations, lifecycle states, episodes, and deterministic eviction.",
		section: "Architecture",
		source: contextCompaction,
	},
	{
		slug: getFrontmatterSlug(taskRuntime),
		title: "Task runtime",
		description:
			"Understand task boundaries, capability snapshots, authority, cancellation, execution evidence, and successor handoff.",
		section: "Architecture",
		source: taskRuntime,
	},
	{
		slug: getFrontmatterSlug(toolDiscovery),
		title: "Tool discovery",
		description:
			"Learn how each task lists, searches, inspects, and loads trusted capabilities from an immutable catalog snapshot.",
		section: "Architecture",
		source: toolDiscovery,
	},
	{
		slug: getFrontmatterSlug(sessions),
		title: "Sessions",
		description:
			"Create and resume durable sessions, configure local or model-generated titles, and understand workspace and SQLite persistence.",
		section: "Advanced",
		source: sessions,
	},
	{
		slug: getFrontmatterSlug(skills),
		title: "Skills",
		description:
			"Create reusable skill instructions, control model discovery, activate skills manually, and troubleshoot loading.",
		section: "Advanced",
		source: skills,
	},
];

export function getDocPage(slug: string): DocPage | undefined {
	return docPages.find((page) => page.slug === slug);
}

const extensions = docsMarkdownExtensions();

export interface RenderedDoc {
	html: string;
	headings: MarkdownHeading[];
}

export function renderDocPage(source: string): RenderedDoc {
	const document = parseMarkdown(source, { frontmatter: true, extensions });
	const html = renderHtml(document, { extensions, headingAnchors: true });
	return { html, headings: document.headings ?? [] };
}
