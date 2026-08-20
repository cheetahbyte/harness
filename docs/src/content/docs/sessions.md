---
title: Sessions
slug: advanced/sessions
---

# Sessions

A session stores a Harnez conversation so you can close the TUI and continue
later. It records the workspace, selected model, event history, context, task
results, and title.

A session can contain many tasks. Each top-level prompt starts a new
[task runtime](/docs/architecture/task-runtime), but later tasks continue the
same conversation.

## Create and resume

Running Harnez without arguments creates a session for the current directory:

```text
harnez
```

The session appears in the resume picker after you submit a message. Opening
and closing the TUI, changing the model, and running setup commands do not add
an empty session to the picker.

Search for a saved session or open one directly by ID:

```text
harnez --resume
harnez --resume <session-id>
```

The picker lists each session's title, workspace, creation time, and ID. If a
session has no title, the picker shows its workspace instead.

Harnez records the workspace when it creates the session. Resuming from a
different directory does not change it. Project settings, tools, and skills
continue to come from the original workspace.

## Session titles

Rename the current session at any time from the TUI:

```text
/session-name <name>
```

Harnez saves the name immediately. Automatic naming will not overwrite it, even
if a naming request is already running.

Automatic naming runs once and uses the first normal user prompt. Follow-ups,
queued prompts, steers, superseding prompts, and restored task data do not
rename the session.

The default title source is local YAKE keyword extraction:

```json
{
  "session": {
    "title": {
      "generated": true,
      "source": "keywords/yake"
    }
  }
}
```

YAKE runs locally and does not call a provider. It selects up to two phrases
from the first prompt and uses English stopwords. If it cannot make a title,
Harnez stores a cleaned 80-character excerpt of the prompt.

Disable automatic titles with:

```json
{
  "session": {
    "title": {
      "generated": false
    }
  }
}
```

Turning generation off still marks the first prompt as used for naming. If you
turn it on later, Harnez will not use a subsequent prompt to name the existing
session.

## Model-generated titles

To use a model instead of local keyword extraction, set `source` to the model's
provider and ID:

```json
{
  "session": {
    "title": {
      "generated": true,
      "source": "model/openai-codex/gpt-5.1-codex:low"
    }
  }
}
```

The format is:

```text
model/<provider>/<model>:<thinking-level>
```

The thinking suffix is optional. Supported values are `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`, and `max`. Harnez clamps the requested level to what
the model supports. Model IDs may contain `/`.

Harnez sends the naming model a fixed title instruction and the first user
prompt. It does not send session history, tools, skills, or the agent system
prompt. The request runs in the background, so the task continues without
waiting. Before sending the request, Harnez saves an excerpt of the prompt as a
fallback. It replaces the excerpt only when the model returns a usable title.

Harnez keeps the fallback if the provider fails, credentials are missing, the
source is invalid, the response is empty, or the model is unsupported. It tries
to generate a title once. An `openai-compatible` naming model can reuse a base
URL only when the session's active model is also `openai-compatible`.

## Settings precedence

You can put session title settings in the global
`~/.config/harnez/settings.json` or the project's `.harnez/settings.json`.
The project can override `generated`, `source`, or both.

See [Configuration](/docs/configuration) for the full settings hierarchy and
provider configuration.

## Persistence

By default, the server stores sessions in `.harnez/harnez.sqlite`. Set
`HARNEZ_DATABASE_PATH` to use another database file.

The SQLite database stores session metadata, events, model selections, context
records, task state, and execution ledgers. When the server opens the database,
Harnez applies schema migrations in transactions. New nullable fields do not
rewrite existing session history.

The event stream stores sequence numbers as resume cursors. When a client
reconnects, it replays events after its last cursor before receiving live events.
Closing the TUI does not discard completed conversation history.

Back up the database before moving it between Harnez versions. A binary refuses
to open a database whose schema is newer than it supports.

## Pasting images

Paste PNG, JPEG, GIF, or WebP images directly into the composer. Each message
accepts up to four images, with an 8 MiB decoded limit per image and 20 MiB in
total. The transcript displays placeholders such as `[Image #1]`; numbering
starts over for every submitted message, and image bytes are not written to
the event log. Images require a configured vision-capable model. Remote and
headless clipboard access, file pickers, drag-and-drop, thumbnails, and image
editing are not supported.

## Current limits

You cannot regenerate or delete a session title manually. Harnez saves title
changes for future listings, but the open TUI does not receive them as live
events. Reopen the resume picker to see a renamed or generated title.
