import { createFileRoute, Link, notFound } from "@tanstack/solid-router";

import { DocsArticle } from "../../content/docs/DocsArticle";
import { getDocPage } from "../../content/docs/manifest";
import { seoMeta } from "../../seo";

export const Route = createFileRoute("/docs/$")({
	loader: ({ params }) => {
		const page = getDocPage(params._splat);
		if (!page) throw notFound();
		return page;
	},
	head: ({ loaderData }) => ({
		meta: loaderData
			? seoMeta({
					title: `${loaderData.title} | Harnez Docs`,
					description: loaderData.description,
					indexable: loaderData.indexable,
				})
			: [],
	}),
	component: DocsPage,
	notFoundComponent: DocsNotFound,
});

function DocsPage() {
	const page = Route.useLoaderData();
	return <DocsArticle page={page()} />;
}

function DocsNotFound() {
	return (
		<div class="docs-prose">
			<h1>Not found</h1>
			<p>
				That page doesn't exist. Back to <Link to="/docs">introduction</Link>.
			</p>
		</div>
	);
}
