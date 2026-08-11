import { createFileRoute } from '@tanstack/solid-router'

import { DocsArticle } from '../../content/docs/DocsArticle'
import { getDocPage } from '../../content/docs/manifest'

export const Route = createFileRoute('/docs/')({
  head: () => ({ meta: [{ title: 'Introduction — harnez docs' }] }),
  component: DocsIndex,
})

const page = getDocPage('introduction')!

function DocsIndex() {
  return <DocsArticle page={page} />
}
