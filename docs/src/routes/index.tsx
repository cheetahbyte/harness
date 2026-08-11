import { createFileRoute } from '@tanstack/solid-router'
import { createSignal } from 'solid-js'

export const Route = createFileRoute('/')({ component: Home })

const INSTALL_COMMAND = 'npm install -g harnez'

const FEATURES = [
  'Model-agnostic agent core (BYOK)',
  'Terminal UI, driven by a lightweight server process',
  'Nothing else. Read the docs, run the binary.',
]

function Home() {
  return (
    <main class="flex min-h-[calc(100vh-3.5rem)] flex-col">
      <div class="mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center px-6 py-24">
        <p class="mb-4 text-[13px] text-fg-faint">// a minimal harness</p>
        <h1 class="text-6xl font-bold tracking-tight text-fg sm:text-7xl">
          Harnez
        </h1>
        <p class="mt-6 max-w-xl text-[15px] leading-relaxed text-fg-dim">
          A minimal harness for building and running coding agents.
        </p>

        <div class="mt-8">
          <CopyCommand command={INSTALL_COMMAND} />
        </div>

        <div class="mt-10 max-w-xl border-t border-border pt-8">
          <ol class="space-y-3 text-[14px] text-fg-dim">
            {FEATURES.map((feature, index) => (
              <li class="flex gap-4">
                <span class="text-fg-faint">
                  {String(index + 1).padStart(2, '0')}
                </span>
                <span>{feature}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <footer class="border-t border-border">
        <div class="mx-auto flex max-w-5xl items-center justify-between px-6 py-5 text-[12px] text-fg-faint">
          <span>harnez</span>
          <a
            href="https://github.com/cheetahbyte/harnez"
            target="_blank"
            rel="noreferrer"
            class="hover:text-fg-dim"
          >
            github.com/cheetahbyte/harnez
          </a>
        </div>
      </footer>
    </main>
  )
}

function CopyCommand(props: { command: string }) {
  const [copied, setCopied] = createSignal(false)

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.command)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable; no-op
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      class="flex w-full max-w-xl items-center justify-between rounded-lg border border-border bg-bg-raised px-5 py-4 text-left transition-colors hover:border-border-strong"
    >
      <span class="text-[14px]">
        <span class="text-fg-faint">$ </span>
        <span class="font-bold text-fg">{props.command}</span>
      </span>
      <span class={`text-[12px] ${copied() ? 'text-accent' : 'text-fg-faint'}`}>
        {copied() ? 'copied' : 'copy'}
      </span>
    </button>
  )
}
