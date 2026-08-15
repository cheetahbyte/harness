---
title: CLI reference
slug: cli-reference
---

# CLI reference

## Starting Harnez

```text
harnez
```

Starts the server if one isn't already running and opens the TUI against it.

## Resuming a session

```text
harnez --resume
harnez --resume <session-id>
```

Run `harnez --resume` without an ID to open a searchable session picker. Add an
ID to resume that session directly. See [Sessions](/docs/advanced/sessions) for
details about workspaces, persistence, and automatic titles.

## Server commands

```text
harnez server start
harnez server status
harnez server stop
harnez server restart
harnez server run
```

| Command | Description |
| --- | --- |
| `harnez server start` | Starts the local server if it is not already running. |
| `harnez server status` | Shows whether the local server is running. |
| `harnez server stop` | Stops the local server. |
| `harnez server restart` | Stops the local server and starts it again with the same configuration. |
| `harnez server run` | Runs the local server in the foreground. |

`restart` waits for the old process to release the port before starting the
replacement, so it never leaves two servers behind. It reports an error instead
of starting one when no server is running, and refuses outright when
`HARNEZ_URL` points at a server it did not spawn — that server is not Harnez's
to restart.

A running server keeps serving the build it started with, so restart it after
an update to pick up new code.

## Updating

```text
harnez update
harnez --version
```

`harnez update` compares the installed version against the `latest` release on
the npm registry. When a newer one exists it installs it with the package
manager that owns the running binary (npm, bun, pnpm, or yarn), then restarts
the local server so the new build is the one serving sessions. An already
current installation reports so and changes nothing.

The server is only restarted once the install has succeeded and the version on
disk matches what was requested, so a failed download never leaves a server
running against a half-updated installation. If the restart itself fails, the
update still stands — finish it with `harnez server restart`.

Updating requires an installation a package manager owns. Running from a source
checkout, or from a binary pointed at by `HARNEZ_BINARY`, reports the available
version and leaves the installation alone.

### Update notifications

The TUI checks for a newer release in the background at startup and shows it in
the top-right corner of the header:

```text
update available: 0.1.8 → 0.2.0 · run `harnez update`
```

The check never blocks startup and a registry that cannot be reached is
ignored. The answer is cached in the data directory for 24 hours, so the notice
appears at most once a day rather than on every launch. Set
`HARNEZ_DISABLE_UPDATE_CHECK=1` to turn it off.

Because the client and server are separate processes, the server can be running
an older build than the client that just launched — after an update where the
restart was skipped, for instance. The header reports that case too, pointing at
`harnez server restart`.

## Slash commands

Typed directly into the TUI composer.

| Command | Description |
| --- | --- |
| `/login [provider]` | Open the provider-authentication wizard. Omit the provider to pick from a list. For example, `/login company-llm` stores that named provider's API key. |
| `/model [provider]` | Open the model picker for a provider, or the current one if omitted. A configured model can also be selected directly: `/model ollama qwen3-coder:30b`. |
| `/model <provider> <model> [base-url]` | Set the active provider, model, and optional custom endpoint directly, without the wizard. The legacy one-off form remains `/model openai-compatible <model> <base-url>`. |
| `/fast-cycle` | Open the fast-cycle picker. `Space` checks or unchecks a model, `Enter` saves the selection. |
| `/mcp` | Open the [MCP server menu](/docs/advanced/mcp#switching-servers-on-and-off). `Space` switches a server on or off, `Enter` saves and reconnects, `Esc` closes. |
| `/session-name <name>` | Set the current session name. Automatic naming will not replace a name you set. |
| `/<skill-name>` | Invoke a skill loaded from `.harnez/skills` or `.agents/skills`. Available skills appear in autocomplete with their own description. |
| `/<prompt-name>` | Expand a prompt template from `.harnez/prompts` or `.agents/prompts` into the prompt. Only recognized as the first word; trailing text is appended to the template. |

## Keyboard shortcuts

| Shortcut | Effect |
| --- | --- |
| `Enter` | Submit. This steers the active task if one is running. |
| `Option/Alt + Enter` | Submit as a queued follow-up, run after the active task finishes. |
| `Esc` | Abort the current step: generation, running tools, and anything pending in it. |
| `Ctrl+T` | Toggle visibility of the model's thinking blocks. |
| `Shift+Tab` | Cycle through the selected model's supported thinking levels. |
| `Ctrl+P` | Switch to the next model picked with `/fast-cycle`. |
| `Cmd+C` | Copy the current terminal selection. |
| `Ctrl+C` | Quit. |
| `↑` / `↓` / `Tab` | Navigate and accept command, prompt-template, or skill autocomplete suggestions. |

Changing the thinking level or the model while a task is running applies it to
the next prompt without interrupting the active task. Each fast-cycle model
keeps its own thinking level, so `Ctrl+P` restores the level that model last
used. Entries whose model is no longer available are skipped.

> [!TIP] Steering vs. aborting
> These map directly onto the three ways to interrupt the [agent
> loop](/docs/architecture#agent-loop): steer, queue a follow-up, or abort.
