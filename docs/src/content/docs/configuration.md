---
title: Configuration
slug: configuration
---

# Configuration

Harnez keeps credentials and global settings in your user config directory.

```text
~/.config/harness/auth.json
~/.config/harness/settings.json
```

`$XDG_CONFIG_HOME/harness` is used instead when that variable is set.

## `auth.json`

This file maps provider IDs to credentials. A credential is either an OAuth
token set or an API key. Harnez writes the file with `0o600` permissions, and
`/login` updates it. Never commit this file.

## `settings.json`

```json
{
  "model": {
    "provider": "openai-codex",
    "model": "gpt-5.1-codex",
    "baseUrl": null,
    "thinkingLevel": "medium"
  },
  "fastCycle": [
    { "provider": "openai-codex", "model": "gpt-5.1-codex", "thinkingLevel": "medium" },
    { "provider": "anthropic", "model": "claude-opus-4-5", "thinkingLevel": "high" }
  ],
  "disableThinkingBlocks": false,
  "session": {
    "title": {
      "generated": true,
      "source": "keywords/yake"
    }
  }
}
```

`model` is whatever `/model` last set. `thinkingLevel` is the last level
selected with `Shift+Tab`; supported levels depend on the model. `baseUrl`
only applies to the `openai-compatible` provider.

`fastCycle` is the list `Ctrl+P` steps through, in the order `/fast-cycle`
listed the models. Each entry carries its own `thinkingLevel`, so `Shift+Tab`
changes the level of the active model only, and selecting that model again
restores it. Entries whose model is unavailable are skipped while cycling.

The picker writes the whole list, so an entry whose model is missing from it —
for example while that provider is signed out — is dropped when you save.
Cycling never drops entries; it only skips the ones it cannot resolve.

New sessions are titled from their first prompt by default. Set
`session.title.generated` to `false` to disable this. `session.title.source`
supports:

- `keywords/yake`: local, deterministic keyword extraction
- `model/<provider>/<model>:<thinking-level>`: a configured model, for example
  `model/openai-codex/gpt-5.1-codex:low`.

The thinking suffix is optional. If the provider is unavailable or returns no
usable title, Harnez keeps a cleaned excerpt of the first prompt. See
[Sessions](/docs/advanced/sessions) for details about title generation and
persistence.

## Project overrides

A project-local `.harness/settings.json` takes precedence over the corresponding
global values for that project. Nested session-title fields are merged
independently, so a project may override only `generated` or only `source`:

```text
<repo>/
  .harness/
    settings.json      # overrides ~/.config/harness/settings.json
    harness.sqlite     # session, event, and context storage
    skills/              # project-local skills, alongside .agents/skills
```

User-level skills live in `~/.harness/skills` and `~/.agents/skills`.

## Environment variables

| Variable | Effect |
| --- | --- |
| `HARNEZ_PORT` | Server listen port. Default `7432`. |
| `HARNEZ_URL` | Server URL the TUI connects to. Default `http://localhost:7432`. |
| `HARNEZ_CONTEXT_BUDGET` | Overrides the context token budget used for compaction. |
| `HARNEZ_LOG_LEVEL` | Pino log level. Default `info`. |
| `HARNEZ_SHOW_STATUS` | Set to `1` to show status and token-usage rows in the TUI transcript. |
| `XDG_CONFIG_HOME` | Overrides the base config directory in place of `~/.config`. |
| `HARNEZ_OPENAI_API_KEY` / `OPENAI_API_KEY` | API key for the `openai-compatible` provider, checked in that order. |
