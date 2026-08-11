import { parseMarkdown } from "@tanstack/markdown/parser";
import { renderHtml } from "@tanstack/markdown/html";
import { docsMarkdownExtensions } from "@tanstack/markdown/extensions/docs";
import type { MarkdownHeading } from "@tanstack/markdown";

import introduction from "./introduction.md?raw";
import installation from "./installation.md?raw";
import architecture from "./architecture.md?raw";
import cliReference from "./cli-reference.md?raw";
import configuration from "./configuration.md?raw";
import contextCompaction from "./context-compaction.md?raw";
import toolDiscovery from "./tool-discovery.md?raw";
import { getFrontmatterSlug } from "./frontmatter";

export interface DocPage {
	slug: string;
	title: string;
	section: string;
	source: string;
}

export const docSections = ["Guide", "Architecture"] as const;

export const docPages: DocPage[] = [
	{
		slug: getFrontmatterSlug(introduction),
		title: "introduction",
		section: "Guide",
		source: introduction,
	},
	{
		slug: getFrontmatterSlug(installation),
		title: "installation",
		section: "Guide",
		source: installation,
	},
	{
		slug: getFrontmatterSlug(architecture),
		title: "architecture",
		section: "Architecture",
		source: architecture,
	},
	{
		slug: getFrontmatterSlug(cliReference),
		title: "cli reference",
		section: "Guide",
		source: cliReference,
	},
	{
		slug: getFrontmatterSlug(configuration),
		title: "configuration",
		section: "Guide",
		source: configuration,
	},
	{
		slug: getFrontmatterSlug(contextCompaction),
		title: "context compaction",
		section: "Architecture",
		source: contextCompaction,
	},
	{
		slug: getFrontmatterSlug(toolDiscovery),
		title: "tool discovery",
		section: "Architecture",
		source: toolDiscovery,
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
