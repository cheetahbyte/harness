export function seoMeta({
	title,
	description,
	indexable = true,
}: {
	title: string;
	description: string;
	indexable?: boolean;
}) {
	return [
		{ title },
		{ name: "description", content: description },
		{ property: "og:title", content: title },
		{ property: "og:description", content: description },
		{ name: "twitter:title", content: title },
		{ name: "twitter:description", content: description },
		...(indexable ? [] : [{ name: "robots", content: "noindex, follow" }]),
	];
}

const xmlEscapes: Record<string, string> = {
	"&": "&amp;",
	'"': "&quot;",
	"'": "&apos;",
	"<": "&lt;",
	">": "&gt;",
};

export function sitemapXml(origin: string, paths: string[]): string {
	const urls = paths.map(
		(path) =>
			`  <url><loc>${new URL(path, origin).href.replace(/[&"'<>]/g, (character) => xmlEscapes[character] ?? character)}</loc></url>`,
	);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
