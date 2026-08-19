/** @jsxImportSource solid-js */
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { renderMermaidBlocks } from "../../components/mermaid";
import { type DocPage, renderDocPage } from "./manifest";

async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		const textarea = document.createElement("textarea");
		try {
			textarea.value = text;
			textarea.style.position = "fixed";
			textarea.style.opacity = "0";
			document.body.appendChild(textarea);
			textarea.select();
			return document.execCommand("copy");
		} catch {
			return false;
		} finally {
			textarea.remove();
		}
	}
}

export function DocsArticle(props: { page: DocPage }) {
	const rendered = () => renderDocPage(props.page.source);
	const toc = () =>
		rendered().headings.filter((h) => h.level === 2 || h.level === 3);
	const [activeId, setActiveId] = createSignal<string | null>(null);
	let articleRef: HTMLElement | undefined;

	onMount(() => {
		if (articleRef) void renderMermaidBlocks(articleRef);
		const cleanups: (() => void)[] = [];
		for (const pre of articleRef?.querySelectorAll("pre.tm-code") ?? []) {
			const button = document.createElement("button");
			button.type = "button";
			button.className = "code-copy";
			button.textContent = "copy";
			button.title = "Copy code";
			button.setAttribute("aria-label", "Copy code");
			let timer: ReturnType<typeof setTimeout> | undefined;
			const onClick = () => {
				const code = pre.querySelector("code");
				if (!code) return;
				void copyText(code.textContent ?? "").then((success) => {
					if (!success) return;
					clearTimeout(timer);
					button.classList.add("copied");
					button.textContent = "copied";
					button.title = "Copied";
					button.setAttribute("aria-label", "Copied");
					timer = setTimeout(() => {
						button.classList.remove("copied");
						button.textContent = "copy";
						button.title = "Copy code";
						button.setAttribute("aria-label", "Copy code");
					}, 1500);
				});
			};
			button.addEventListener("click", onClick);
			pre.appendChild(button);
			cleanups.push(() => {
				clearTimeout(timer);
				button.removeEventListener("click", onClick);
			});
		}
		onCleanup(() =>
			cleanups.forEach((cleanup) => {
				cleanup();
			}),
		);

		const ids = toc().map((h) => h.id);
		const elements = ids
			.map((id) => document.getElementById(id))
			.filter((el): el is HTMLElement => el !== null);
		if (elements.length === 0) return;

		const visible = new Set<string>();
		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) visible.add(entry.target.id);
					else visible.delete(entry.target.id);
				}
				const current = ids.find((id) => visible.has(id));
				if (current) setActiveId(current);
			},
			{ rootMargin: "-80px 0px -70% 0px", threshold: 0 },
		);
		for (const el of elements) observer.observe(el);
		onCleanup(() => observer.disconnect());
	});

	return (
		<div class="flex gap-12 xl:gap-16">
			<article
				ref={articleRef}
				class="docs-prose min-w-0 flex-1"
				innerHTML={rendered().html}
			/>
			<Show when={toc().length > 0}>
				<aside class="hidden w-48 shrink-0 xl:block">
					<div class="sticky top-24">
						<p class="mb-4 text-[11px] tracking-widest text-fg-faint">
							ON THIS PAGE
						</p>
						<nav class="flex flex-col gap-2.5 text-[13px] lowercase leading-snug">
							<For each={toc()}>
								{(heading) => (
									<a
										href={`#${heading.id}`}
										class="transition-colors"
										classList={{
											"pl-3": heading.level === 3,
											"font-bold text-accent": activeId() === heading.id,
											"text-fg-dim hover:text-fg": activeId() !== heading.id,
										}}
									>
										{heading.text}
									</a>
								)}
							</For>
						</nav>
					</div>
				</aside>
			</Show>
		</div>
	);
}
