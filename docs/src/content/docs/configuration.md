---
title: Configuration
slug: configuration
---

# Configuration

Harnez stores credentials and settings outside of your project, in your user
config directory.

```text
~/.config/harnez/auth.json
~/.config/harnez/settings.json
```

`$XDG_CONFIG_HOME/harnez` is used instead when that variable is set.

## `auth.json`

A JSON map of provider ID to credential, either an OAuth token set or an API
key, written with `0o600` permissions. `/login` populates it. Never commit
this file.

## `settings.json`

```json
{
  "model": {
    "provider": "openai-codex",
    "model": "gpt-5.1-codex",
    "baseUrl": null
  },
  "disableThinkingBlocks": false
}
```

`model` is whatever `/model` last set. `baseUrl` only applies to the
`openai-compatible` provider.

## Project overrides

A project-local `.harnez/settings.json` takes precedence over the global one
for that project. It replaces the global file instead of being merged:

```text
<repo>/
  .harnez/
    settings.json      # overrides ~/.config/harnez/settings.json
    harnez.sqlite      # session, event, and context storage
    skills/              # project-local skills, alongside .agents/skills
```

User-level skills live in `~/.harnez/skills` and `~/.agents/skills`.

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
