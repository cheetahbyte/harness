---
title: Configuration
slug: configuration
---

# Configuration

Harnez stores credentials and global settings in your user configuration
directory.

```text
~/.config/harnez/auth.json
~/.config/harnez/settings.json
```

`$XDG_CONFIG_HOME/harnez` is used instead when that variable is set.

User configuration has one canonical root. Legacy `harness`, `~/.harnez`, and
`~/.harness` user directories are not scanned.

## `auth.json`

This file maps provider IDs to credentials. A credential is an OAuth token set
or an API key. Harnez writes the file with `0o600` permissions, and `/login`
updates it. Never commit this file.

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
  "compaction": {
    "enabled": true,
    "model": "ollama/gpt-oss:20b"
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
`/login`, `/model`, and the model header. Each provider needs an absolute
HTTP(S) `baseUrl`, `auth` set to `none` or `api-key`, and a non-empty list of
unique, non-empty model IDs. IDs cannot collide with built-in providers or the
legacy `openai-compatible` provider. Invalid definitions identify the settings file
and provider ID before a model request starts.

Use `/login company-llm` to store an API key for an `api-key` provider. Harnez
stores keys only in `auth.json` under that provider ID, using the file's
existing `0o600` permissions. Do not put keys in `settings.json`. An
`auth: "none"` provider is available immediately. Harnez gives its OpenAI
client a fixed placeholder key, so compatible local servers must accept an
`Authorization: Bearer unused` header.

`model` is the value most recently set by `/model`. `thinkingLevel` is the
level most recently selected with `Shift+Tab`; supported levels depend on the
model. `baseUrl` applies only to the `openai-compatible` provider.

`compaction.enabled` defaults to `true`. `compaction.model` optionally selects
a separate model for context compaction in `<provider>/<model>` form. Harnez
uses `model` when this value is omitted. Project settings override global
settings.

`fastCycle` is the list that `Ctrl+P` cycles through, in the order that
`/fast-cycle` lists the models. Each entry has its own `thinkingLevel`.
`Shift+Tab` changes the active model's level, and selecting that model again
restores it. Harnez skips unavailable models while cycling.

The picker writes the whole list. When a model is missing from the list, for
example because its provider is signed out, Harnez drops that entry when you
save. Cycling does not drop entries. It skips models that it cannot resolve.

`disabledMcpServers` lists the servers that
[`/mcp`](/docs/advanced/mcp#switching-servers-on-and-off) switched off, by
server name. The list contains exclusions, so a server added to `mcp.json`
later starts connected. The setting follows the same layering as other
settings. Harnez writes it to the project's `.harnez/settings.json` when that
file exists, or to the global file otherwise. Because entries are plain server
names, the setting applies to every workspace that has a server with that
name.

Harnez titles new sessions from their first prompt by default. Set
`session.title.generated` to `false` to disable generated titles.
`session.title.source` supports:

- `keywords/yake`: local, deterministic keyword extraction
- `model/<provider>/<model>:<thinking-level>`: a configured model, for example
  `model/openai-codex/gpt-5.1-codex:low`.

The thinking suffix is optional. If the provider is unavailable or returns no
usable title, Harnez keeps a cleaned excerpt of the first prompt. See
[Sessions](/docs/advanced/sessions) for details about title generation and
persistence.

## Project overrides

A project-local `.harnez/settings.json` takes precedence over the corresponding
global values for that project. Harnez merges nested session-title fields
independently, so a project can override only `generated` or only `source`:

```text
<repo>/
  .harnez/
    settings.json      # overrides ~/.config/harnez/settings.json
    skills/              # project-local skills, alongside .agents/skills
    prompts/             # project-local prompt templates, alongside .agents/prompts
```

Harnez merges provider maps by provider ID. A project provider with the same ID
replaces the complete global definition. Restart the server after editing
either settings file. Harnez does not reload settings while the server runs.

The legacy one-off endpoint command is still available:

```text
/model openai-compatible <model> <base-url>
```

User-level skills live in `~/.config/harnez/skills` and `~/.agents/skills`.
User-level prompt templates live in `~/.config/harnez/prompts` and
`~/.agents/prompts`.

## System prompt files

You can replace or extend the built-in operator prompt with Markdown files:

```text
$XDG_CONFIG_HOME/harnez/SYSTEM.md             # replace the built-in prompt
$XDG_CONFIG_HOME/harnez/APPEND_SYSTEM.md      # append global rules
<repo>/.harnez/APPEND_SYSTEM.md                # append project rules
```

When `$XDG_CONFIG_HOME` is unset, Harnez uses `~/.config`. Harnez resolves the
files in the order shown: `SYSTEM.md` or the built-in prompt, global append,
then project append. A project cannot replace the operator prompt because
project-local `SYSTEM.md` is not supported.

Harnez fixes the resolved prompt when a new session first runs an agent task.
Editing these files affects new sessions only. Existing sessions retain their
prompt, including after a server restart. `SYSTEM.md` replaces the built-in
capability and compaction guidance, so use `APPEND_SYSTEM.md` to keep those
instructions. Harnez removes leading and trailing whitespace from each body
and separates non-empty bodies with two newlines. It ignores empty append
files. An empty `SYSTEM.md` is a valid replacement. Invalid UTF-8, directories,
and other read failures stop task startup and identify the file path in the
error.

## Environment variables

| Variable | Effect |
| --- | --- |
| `HARNEZ_PORT` | Server listen port. Default `7432`. |
| `HARNEZ_URL` | Server URL the TUI connects to. Default `http://localhost:7432`. |
| `HARNEZ_LOG_LEVEL` | Pino log level. Default `info`. |
| `HARNEZ_OTEL` | Set to `1` to enable OpenTelemetry traces and metrics. |
| `HARNEZ_OTEL_CAPTURE_CONTENT` | Comma-separated opt-in payload categories, or `all`. Default empty. |
| `HARNEZ_OTEL_CAPTURE_MAX_CHARS` | Maximum characters per captured telemetry payload. Default `16384`; maximum `1000000`. |
| `HARNEZ_SHOW_STATUS` | Set to `1` to show status and token-usage rows in the TUI transcript. |
| `XDG_CONFIG_HOME` | Overrides the base config directory in place of `~/.config`. |
| `XDG_DATA_HOME` | Overrides the user data base directory in place of `~/.local/share`. |
| `HARNEZ_DATA_DIR` | Overrides the complete Harnez user data directory. |
| `HARNEZ_OPENAI_API_KEY` / `OPENAI_API_KEY` | API key for the `openai-compatible` provider, checked in that order. |

Set `HARNEZ_OTEL=1` to enable OpenTelemetry export. Harnez then uses the
standard `OTEL_*` variables for the endpoint, protocol, headers, service name,
resource attributes, exporters, and sampling. Content capture is disabled by
default. Read [Observability](/docs/advanced/observability) before enabling it.

Harnez manages model context automatically. When `compaction.enabled` is true,
the runtime can condense older history before it uses deterministic checkpoint
compaction. A provider context-length error creates a recovery checkpoint, and
Harnez retries once with the current turn preserved.
