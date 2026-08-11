import { parseMarkdown } from "@tanstack/markdown/parser";
import { renderHtml } from "@tanstack/markdown/html";
import { docsMarkdownExtensions } from "@tanstack/markdown/extensions/docs";
import type { MarkdownHeading } from "@tanstack/markdown";

import introduction from "./introduction.md?raw";
import installation from "./installation.md?raw";
import architecture from "./architecture.md?raw";
import cliReference from "./cli-reference.md?raw";
import configuration from "./configuration.md?raw";

export interface DocPage {
	slug: string;
	title: string;
	section: string;
	source: string;
}

export const docSections = ["Guide", "Architecture"] as const;

export const docPages: DocPage[] = [
	{
		slug: "introduction",
		title: "introduction",
		section: "Guide",
		source: introduction,
	},
	{
		slug: "installation",
		title: "installation",
		section: "Guide",
		source: installation,
	},
	{
		slug: "architecture",
		title: "architecture",
		section: "Guide",
		source: architecture,
	},
	{
		slug: "cli-reference",
		title: "cli reference",
		section: "Architecture",
		source: cliReference,
	},
	{
		slug: "configuration",
		title: "configuration",
		section: "Architecture",
		source: configuration,
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
