import { parseMarkdown } from "@tanstack/markdown/parser";

export function getFrontmatterSlug(source: string): string {
	const slug = parseMarkdown(source, { frontmatter: true })
		.frontmatter?.split("\n")
		.find((line) => line.startsWith("slug:"))
		?.slice("slug:".length)
		.trim();
	if (!slug) throw new Error("Documentation page is missing a frontmatter slug");
	return slug;
}
