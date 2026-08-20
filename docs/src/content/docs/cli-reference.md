---
title: CLI reference
slug: cli-reference
---

# CLI reference

## Starting Harnez

```text
harnez
```

Starts the server if it is not already running, then opens the TUI.

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
replacement, so it does not leave two servers running. It reports an error
instead of starting a server when none is running. It also refuses to restart
a server that `HARNEZ_URL` points to if Harnez did not spawn that server.

A running server continues to serve the build it started with. Restart it after
an update to use the new code.

## Updating

```text
harnez update
harnez --version
```

`harnez update` compares the installed version with the `latest` release on
the npm registry. When a newer release exists, it installs the release with
the package manager that owns the running binary, such as npm, bun, pnpm, or
yarn. It then restarts the local server so the new build serves sessions. An
up-to-date installation reports that it is current and makes no changes.

Harnez restarts the server only after the installation succeeds and the version
on disk matches the requested version. A failed download therefore does not
leave a server running against a partial installation. If the restart fails,
the update remains installed. Run `harnez server restart` to finish.

Updating requires an installation that a package manager owns. If you run from
a source checkout or from a binary specified by `HARNEZ_BINARY`, Harnez reports
the available version and leaves the installation unchanged.

### Update notifications

At startup, the TUI checks for a newer release in the background and shows it
in the header:

```text
update available: 0.1.8 → 0.2.0 · run `harnez update`
```

The check does not block startup. Harnez ignores an unreachable registry. It
caches the result in the data directory for 24 hours, so the notice appears at
most once a day. Set `HARNEZ_DISABLE_UPDATE_CHECK=1` to disable the check.

The client and server are separate processes, so the server can run an older
build than the client that just launched. This can happen when an update skips
the restart. The header reports this case and points to `harnez server restart`.

## Slash commands

Type these commands directly into the TUI composer.

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

Changing the thinking level or model while a task runs applies the change to
the next prompt without interrupting the active task. Each fast-cycle model
keeps its own thinking level, so `Ctrl+P` restores the level that model last
used. Harnez skips entries whose models are no longer available.

> [!TIP] Steering vs. aborting
> These map directly onto the three ways to interrupt the [agent
> loop](/docs/architecture#agent-loop): steer, queue a follow-up, or abort.
