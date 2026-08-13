---
title: Prompt templates
slug: advanced/prompt-templates
---

# Prompt templates

A prompt template is a reusable prompt stored in a Markdown file. Typing
`/<name>` as the first word of a prompt replaces it with the file's contents
before the task starts, so a long instruction you send often becomes one word.

Templates are text, not tools. They do not add capabilities to a task; they
only decide what the task's first message says.

## Locations

Harnez scans four roots in this order:

| Scope | Location |
| --- | --- |
| Project | `.harnez/prompts/<name>.md` |
| Project, shared | `.agents/prompts/<name>.md` |
| User | `~/.harnez/prompts/<name>.md` |
| User, shared | `~/.agents/prompts/<name>.md` |

Each template is one `.md` file directly inside a root. Harnez does not scan
nested directories or files with another extension. When the same name appears
more than once, the first valid file in the order above wins, so a project
template shadows a user template of the same name.

## Create a template

```text
.harnez/prompts/
└── review-pr.md
```

The file is the prompt. Frontmatter is optional:

```md
---
description: Review an open pull request
---

Read the diff on the current branch. Report correctness defects first, then
anything that duplicates code we already have.
```

Without frontmatter, the whole file is the prompt and its first line becomes
the autocomplete description.

## Frontmatter

| Field | Required | Behavior |
| --- | --- | --- |
| `name` | No | Overrides the file name as the slash name. |
| `description` | No | Autocomplete text, limited to 2,000 characters. Defaults to the first line of the body. |

Names must start with a lowercase letter or number and may contain lowercase
letters, numbers, and hyphens, so `review-pr.md` is invoked as `/review-pr`.
Harnez ignores unknown frontmatter fields, which keeps room for template
metadata and arguments later.

A file is invalid, and stays out of autocomplete, when its name does not match
that pattern, its frontmatter is not a YAML mapping, or its body is empty. The
server logs the path and the reason for each file it skips.

## Invoke a template

Type the name and press Enter. Autocomplete lists templates alongside skills
and built-in commands:

```text
/review-pr
```

Anything you type after the name is appended to the expanded prompt as a
separate paragraph, so context stays with the invocation:

```text
/review-pr focus on the migration
```

The transcript keeps showing what you typed. The model receives the expanded
text.

Expansion happens when a task starts, which covers new prompts and queued
follow-ups. Text that steers an already-running task reaches the model as
typed, the same way skills are not activated mid-task.

## Resolution order

Only the first word of a new prompt is an invocation. A slash name later in the
text is left alone, which keeps it available for skill activation.

A leading `/<name>` resolves in one order:

1. A built-in command such as `/model` or `/login`.
2. A prompt template.
3. A skill.

A template therefore shadows a skill with the same name, and a built-in command
shadows both. Because expansion runs before skills are selected, a template body
may activate a skill by including its slash name:

```md
/release-notes

Draft notes for the commits since the last tag.
```

Templates are read when the task starts. Editing a file changes the next
invocation; a running task keeps the prompt it started with.

See [Skills](/docs/advanced/skills) for reusable instructions the model can
activate on its own.
