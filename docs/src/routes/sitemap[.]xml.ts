import { createFileRoute } from "@tanstack/solid-router";

import { docPages } from "../content/docs/manifest";
import { sitemapXml } from "../seo";

export const Route = createFileRoute("/sitemap.xml")({
	server: {
		handlers: {
			GET: ({ request }) =>
				new Response(
					sitemapXml(new URL(request.url).origin, [
						"/",
						"/docs",
						...docPages
							.filter(
								(page) =>
									page.slug !== "introduction" && page.indexable !== false,
							)
							.map((page) => `/docs/${page.slug}`),
					]),
					{ headers: { "content-type": "application/xml; charset=utf-8" } },
				),
		},
	},
});
