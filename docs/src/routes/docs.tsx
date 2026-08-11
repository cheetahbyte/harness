import { Link, Outlet, createFileRoute } from "@tanstack/solid-router";
import { For, Show } from "solid-js";

import { docPages, docSections } from "../content/docs/manifest";

export const Route = createFileRoute("/docs")({ component: DocsLayout });

function DocsLayout() {
	return (
		<main class="mx-auto flex max-w-[100rem]">
			<aside class="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-56 shrink-0 overflow-y-auto border-r border-border px-6 py-10 sm:block">
				<nav class="flex flex-col gap-2">
					<For each={docSections}>
						{(section) => (
							<section class="mt-6 flex flex-col gap-2 first:mt-0">
								<p class="mb-4 text-[11px] uppercase tracking-widest text-fg-faint">
									{section}
								</p>
								<For each={docPages.filter((page) => page.section === section)}>
									{(page) => (
										<Show
											when={page.slug !== "introduction"}
											fallback={
												<Link
													to="/docs"
													class="border-l-2 border-transparent pl-3 text-[13px] lowercase tracking-widest text-fg-faint transition-colors hover:text-fg"
													activeProps={{
														class:
															"border-l-2 border-accent pl-3 font-bold text-fg",
													}}
													activeOptions={{ exact: true }}
												>
													{page.title}
												</Link>
											}
										>
											<Link
												to="/docs/$slug"
												params={{ slug: page.slug }}
												class="border-l-2 border-transparent pl-3 text-[13px] lowercase tracking-widest text-fg-faint transition-colors hover:text-fg"
												activeProps={{
													class:
														"border-l-2 border-accent pl-3 font-bold text-fg",
												}}
											>
												{page.title}
											</Link>
										</Show>
									)}
								</For>
							</section>
						)}
					</For>
				</nav>
			</aside>
			<div class="min-w-0 flex-1 px-6 py-10 sm:px-10 xl:px-14">
				<Outlet />
			</div>
		</main>
	);
}
