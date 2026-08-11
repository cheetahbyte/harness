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
The TUI and server are separate, so during development you can run them
independently:

```text
bun run server   # HARNEZ_PORT, default 7432
bun run tui      # HARNEZ_URL, default http://localhost:7432
```

## Slash commands

Typed directly into the TUI composer.

| Command | Description |
| --- | --- |
| `/login [provider]` | Open the provider-authentication wizard. Omit the provider to pick from a list. |
| `/model [provider]` | Open the model picker for a provider, or the current one if omitted. |
| `/model <provider> <model> [base-url]` | Set the active provider, model, and optional custom endpoint directly, without the wizard. |
| `/<skill-name>` | Invoke a skill loaded from `.harnez/skills` or `.agents/skills`. Available skills appear in autocomplete with their own description. |

## Keyboard shortcuts

| Shortcut | Effect |
| --- | --- |
| `Enter` | Submit. This steers the active task if one is running. |
| `Option/Alt + Enter` | Submit as a queued follow-up, run after the active task finishes. |
| `Esc` | Abort the current step: generation, running tools, and anything pending in it. |
| `Ctrl+T` | Toggle visibility of the model's thinking blocks. |
| `Cmd+C` | Copy the current terminal selection. |
| `Ctrl+C` | Quit. |
| `↑` / `↓` / `Tab` | Navigate and accept command or skill autocomplete suggestions. |

> [!TIP] Steering vs. aborting
> These map directly onto the three ways to interrupt the [agent
> loop](/docs/architecture#agent-loop): steer, queue a follow-up, or abort.
