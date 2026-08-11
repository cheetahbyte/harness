import { createFileRoute } from "@tanstack/solid-router";

import { DocsArticle } from "../../content/docs/DocsArticle";
import { getDocPage } from "../../content/docs/manifest";
import { seoMeta } from "../../seo";

const page = getDocPage("introduction");

export const Route = createFileRoute("/docs/")({
	head: () => ({
		meta: page
			? seoMeta({
					title: `${page.title} | Harnez Docs`,
					description: page.description,
					indexable: page.indexable,
				})
			: [],
	}),
	component: DocsIndex,
});

function DocsIndex() {
	if (!page) throw new Error("Introduction page is missing");
	return <DocsArticle page={page} />;
}
