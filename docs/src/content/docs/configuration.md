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
  "providers": {
    "ollama": {
      "type": "openai-compatible",
      "baseUrl": "http://localhost:11434/v1",
      "auth": "none",
      "models": ["qwen3-coder:30b", "gpt-oss:20b"]
    },
    "company-llm": {
      "type": "openai-compatible",
      "baseUrl": "https://llm.example.com/v1",
      "auth": "api-key",
      "models": ["company-coder", "company-chat"]
    }
  },
  "model": {
    "provider": "ollama",
    "model": "qwen3-coder:30b",
    "thinkingLevel": "medium"
  },
  "fastCycle": [
    { "provider": "openai-codex", "model": "gpt-5.1-codex", "thinkingLevel": "medium" },
    { "provider": "anthropic", "model": "claude-opus-4-5", "thinkingLevel": "high" }
  ],
  "disableThinkingBlocks": false,
  "disabledMcpServers": ["spokenly"],
  "session": {
    "title": {
      "generated": true,
      "source": "keywords/yake"
    }
  }
}
```

`providers` defines named OpenAI-compatible endpoints. Provider IDs appear in
`/login`, `/model`, and the model header. Each provider requires an absolute
HTTP(S) `baseUrl`, `auth` set to `none` or `api-key`, and a non-empty list of
unique, non-empty model IDs. IDs cannot collide with built-in providers or the
legacy `openai-compatible` provider. Invalid definitions report the settings
file and provider ID before a model request starts.

Use `/login company-llm` to store an API key for an `api-key` provider. Keys
are stored only in `auth.json` under that provider ID, with its existing
`0o600` permissions; do not put keys in `settings.json`. An `auth: "none"`
provider is immediately available. Harnez supplies its OpenAI client a fixed
placeholder key, so compatible local servers must tolerate an
`Authorization: Bearer unused` header.

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

`disabledMcpServers` is what [`/mcp`](/docs/advanced/mcp#switching-servers-on-and-off)
switched off, by server name. It lists exclusions rather than inclusions, so a
server added to `mcp.json` later starts out connected. It follows the same
layering as every other setting: the list lands in the project's
`.harnez/settings.json` when that file exists, and in the global file
otherwise — where, because the entries are plain server names, it applies to
every workspace that has a server by that name.

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

Provider maps merge by provider ID. A project provider with the same ID
replaces that complete global definition. Restart the server after editing
either settings file; settings are not reloaded while it runs.

The legacy one-off endpoint command remains available:

```text
/model openai-compatible <model> <base-url>
```

User-level skills live in `~/.harnez/skills` and `~/.agents/skills`, and
user-level prompt templates in `~/.harnez/prompts` and `~/.agents/prompts`. The
pre-rename `.harness` directories are still scanned, ranking just below their
`.harnez` counterparts.

## System prompt files

The built-in operator prompt can be replaced or extended with Markdown files:

```text
$XDG_CONFIG_HOME/harnez/SYSTEM.md             # replace the built-in prompt
$XDG_CONFIG_HOME/harnez/APPEND_SYSTEM.md      # append global rules
<repo>/.harnez/APPEND_SYSTEM.md                # append project rules
```

When `$XDG_CONFIG_HOME` is unset, `~/.config` is used. Existing files under
`harness` are accepted as a legacy fallback for each corresponding `harnez`
path. If both names exist, the `harnez` file wins. The files are resolved in
the order shown: `SYSTEM.md` (or the built-in prompt), global append, then
project append. A project cannot replace the operator prompt because
project-local `SYSTEM.md` is not supported.

The resolved prompt is fixed when a new session first runs an agent task.
Editing these files affects new sessions only; existing sessions retain their
prompt, including after a server restart. `SYSTEM.md` replaces the built-in
capability and compaction guidance, so use `APPEND_SYSTEM.md` when you want to
keep those instructions. Leading and trailing whitespace is removed from each
body, and non-empty bodies are separated by two newlines. Empty append files
are ignored; an empty `SYSTEM.md` is a valid replacement. Invalid UTF-8,
directories, and other read failures stop task startup and identify the file
path in the error.

## Environment variables

| Variable | Effect |
| --- | --- |
| `HARNEZ_PORT` | Server listen port. Default `7432`. |
| `HARNEZ_URL` | Server URL the TUI connects to. Default `http://localhost:7432`. |
| `HARNEZ_CONTEXT_BUDGET` | Overrides the context token budget used for compaction. |
| `HARNEZ_LOG_LEVEL` | Pino log level. Default `info`. |
| `HARNEZ_OTEL` | Set to `1` to enable OpenTelemetry traces and metrics. |
| `HARNEZ_OTEL_CAPTURE_CONTENT` | Comma-separated opt-in payload categories, or `all`. Default empty. |
| `HARNEZ_OTEL_CAPTURE_MAX_CHARS` | Maximum characters per captured telemetry payload. Default `16384`; maximum `1000000`. |
| `HARNEZ_SHOW_STATUS` | Set to `1` to show status and token-usage rows in the TUI transcript. |
| `XDG_CONFIG_HOME` | Overrides the base config directory in place of `~/.config`. |
| `HARNEZ_OPENAI_API_KEY` / `OPENAI_API_KEY` | API key for the `openai-compatible` provider, checked in that order. |

Set `HARNEZ_OTEL=1` to enable OpenTelemetry export. Harnez then uses the
standard `OTEL_*` variables for endpoint, protocol, headers, service name,
resource attributes, exporters, and sampling. Content capture is disabled by
default; see [Observability](/docs/advanced/observability) before enabling it.
