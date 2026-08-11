import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from '@tanstack/solid-router'

import { HydrationScript } from 'solid-js/web'
import { Suspense } from 'solid-js'

import styleCss from '../styles.css?url'

const GITHUB_URL = 'https://github.com/cheetahbyte/harnez'

export const Route = createRootRouteWithContext()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'harnez - a minimal harness' },
      {
        name: 'description',
        content:
          'A minimal harness for building and running coding agents.',
      },
    ],
    links: [{ rel: 'stylesheet', href: styleCss }],
  }),
  shellComponent: RootComponent,
})

function RootComponent() {
  return (
    <html>
      <head>
        <HydrationScript />
        <HeadContent />
      </head>
      <body>
        <Suspense>
          <div class="flex min-h-screen flex-col">
            <SiteHeader />
            <div class="flex-1">
              <Outlet />
            </div>
          </div>
        </Suspense>
        <Scripts />
      </body>
    </html>
  )
}

function SiteHeader() {
  return (
    <header class="sticky top-0 z-10 border-b border-border bg-bg">
      <div class="flex h-14 items-center justify-between px-6">
        <Link to="/" class="text-[15px] font-bold tracking-tight text-fg">
          harnez<span class="text-accent">_</span>
        </Link>
        <nav class="flex items-center gap-6 text-[13px] text-fg-dim">
          <Link
            to="/"
            class="transition-colors hover:text-fg"
            activeProps={{ class: 'text-accent' }}
            activeOptions={{ exact: true }}
          >
            home
          </Link>
          <Link
            to="/docs"
            class="transition-colors hover:text-fg"
            activeProps={{ class: 'text-accent' }}
          >
            docs
          </Link>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noreferrer"
            class="inline-flex items-center gap-1 transition-colors hover:text-fg"
          >
            github <span aria-hidden="true">↗</span>
          </a>
        </nav>
      </div>
    </header>
  )
}
