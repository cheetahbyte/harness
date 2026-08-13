---
title: Configuration
slug: configuration
---

# Configuration

Harnez keeps credentials and global settings in your user config directory.

```text
~/.config/harnez/auth.json
~/.config/harnez/settings.json
```

`$XDG_CONFIG_HOME/harnez` is used instead when that variable is set.

These directories were named `harness` before the project was renamed. An
install that still has the old name keeps working: each location is read from
its pre-rename spelling whenever the new one is absent, and writes go back to
whichever file was found. Nothing needs to be moved by hand, though renaming
`harness` to `harnez` yourself is harmless.

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

A project-local `.harnez/settings.json` takes precedence over the corresponding
global values for that project. Nested session-title fields are merged
independently, so a project may override only `generated` or only `source`:

```text
<repo>/
  .harnez/
    settings.json      # overrides ~/.config/harnez/settings.json
    harnez.sqlite     # session, event, and context storage
    skills/              # project-local skills, alongside .agents/skills
    prompts/             # project-local prompt templates, alongside .agents/prompts
```

User-level skills live in `~/.harnez/skills` and `~/.agents/skills`, and
user-level prompt templates in `~/.harnez/prompts` and `~/.agents/prompts`. The
pre-rename `.harness` directories are still scanned, ranking just below their
`.harnez` counterparts.

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
