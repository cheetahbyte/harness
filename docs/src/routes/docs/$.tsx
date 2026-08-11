import { createFileRoute, Link, notFound } from "@tanstack/solid-router";

import { DocsArticle } from "../../content/docs/DocsArticle";
import { getDocPage } from "../../content/docs/manifest";

export const Route = createFileRoute("/docs/$")({
	loader: ({ params }) => {
		const page = getDocPage(params._splat);
		if (!page) throw notFound();
		return page;
	},
	head: ({ loaderData }) => ({
		meta: loaderData ? [{ title: `${loaderData.title} - harnez docs` }] : [],
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
