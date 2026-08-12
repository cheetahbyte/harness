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
harnez server run
```

| Command | Description |
| --- | --- |
| `harnez server start` | Starts the local server if it is not already running. |
| `harnez server status` | Shows whether the local server is running. |
| `harnez server stop` | Stops the local server. |
| `harnez server run` | Runs the local server in the foreground. |

## Slash commands

Typed directly into the TUI composer.

| Command | Description |
| --- | --- |
| `/login [provider]` | Open the provider-authentication wizard. Omit the provider to pick from a list. |
| `/model [provider]` | Open the model picker for a provider, or the current one if omitted. |
| `/model <provider> <model> [base-url]` | Set the active provider, model, and optional custom endpoint directly, without the wizard. |
| `/fast-cycle` | Open the fast-cycle picker. `Space` checks or unchecks a model, `Enter` saves the selection. |
| `/session-name <name>` | Set the current session name. Automatic naming will not replace a name you set. |
| `/<skill-name>` | Invoke a skill loaded from `.harnez/skills` or `.agents/skills`. Available skills appear in autocomplete with their own description. |
| `/<prompt-name>` | Expand a prompt template from `.harness/prompts` or `.agents/prompts` into the prompt. Only recognized as the first word; trailing text is appended to the template. |

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
