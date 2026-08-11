import { createFileRoute } from "@tanstack/solid-router";

export const Route = createFileRoute("/robots.txt")({
	server: {
		handlers: {
			GET: ({ request }) =>
				new Response(
					`User-agent: *\nAllow: /\nSitemap: ${new URL("/sitemap.xml", request.url)}\n`,
					{ headers: { "content-type": "text/plain; charset=utf-8" } },
				),
		},
	},
});
