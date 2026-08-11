import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'

import { type DocPage, renderDocPage } from './manifest'

export function DocsArticle(props: { page: DocPage }) {
  const rendered = () => renderDocPage(props.page.source)
  const toc = () => rendered().headings.filter(h => h.level === 2 || h.level === 3)
  const [activeId, setActiveId] = createSignal<string | null>(null)

  onMount(() => {
    const ids = toc().map(h => h.id)
    const elements = ids
      .map(id => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null)
    if (elements.length === 0) return

    const visible = new Set<string>()
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id)
          else visible.delete(entry.target.id)
        }
        const current = ids.find(id => visible.has(id))
        if (current) setActiveId(current)
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    )
    for (const el of elements) observer.observe(el)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div class="flex gap-12 xl:gap-16">
      <article class="docs-prose min-w-0 flex-1" innerHTML={rendered().html} />
      <Show when={toc().length > 0}>
        <aside class="hidden w-48 shrink-0 xl:block">
          <div class="sticky top-24">
            <p class="mb-4 text-[11px] tracking-widest text-fg-faint">ON THIS PAGE</p>
            <nav class="flex flex-col gap-2.5 text-[13px] leading-snug">
              <For each={toc()}>
                {heading => (
                  <a
                    href={`#${heading.id}`}
                    class="transition-colors"
                    classList={{
                      'pl-3': heading.level === 3,
                      'font-bold text-accent': activeId() === heading.id,
                      'text-fg-dim hover:text-fg': activeId() !== heading.id,
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
  )
}
