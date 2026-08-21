---
title: Skills
slug: advanced/skills
---

# Skills

Skills are reusable instructions in `SKILL.md` files. Harnez reads each skill's
name and description when a task starts. It adds the full instructions to task
context only after the model or user activates the skill.

> Review a skill before using it. Its instructions can ask the model to run
> commands or modify files with the tools available to the task.

## Locations

Harnez scans four roots in this order:

| Scope | Location |
| --- | --- |
| Project | `.harnez/skills/<name>/SKILL.md` |
| Project, shared | `.agents/skills/<name>/SKILL.md` |
| User | `~/.config/harnez/skills/<name>/SKILL.md` |
| User, shared | `~/.agents/skills/<name>/SKILL.md` |

Each skill must be one directory below a root. Harnez does not scan parent
directories, nested skill directories, `.claude/skills`, or `.codex/skills`.
When the same skill name appears more than once, the first valid definition in
the order above wins.

## Create a skill

Create a directory and add `SKILL.md`:

```text
.harnez/skills/release-notes/
└── SKILL.md
```

The file starts with YAML frontmatter followed by the instructions:

```md
---
name: release-notes
description: Draft release notes from repository history. Use when preparing a release.
tags: [git, release]
---

# Release notes

Read the commits since the previous tag. Group user-facing changes by area and
write a short upgrade note for any breaking change.
```

Use the description to tell the model what the skill does and when to use it.
The body can be longer because Harnez does not add it to context until
activation.

## Frontmatter

| Field | Required | Behavior |
| --- | --- | --- |
| `name` or `id` | Yes | Canonical skill name. If both are present, they must match. |
| `description` | Yes | Discovery text, limited to 2,000 characters. |
| `tags` | No | A YAML list or comma-separated string. Each tag is limited to 100 characters. |
| `disable-model-invocation` | No | Set to `true` to hide the skill from model discovery. Defaults to `false`. |

Names must start with a lowercase letter or number and may contain lowercase
letters, numbers, and hyphens. Harnez ignores unknown frontmatter fields.

## Activate a skill

The model can find model-discoverable skills through `capabilities_list` and
`capabilities_search`, then activate one with `skills_activate`. Discovery
returns metadata only. The skill body enters task context after activation.

You can activate any skill directly by putting its slash name in a new task
prompt:

```text
/release-notes prepare version 1.4
```

Harnez removes `/release-notes`, activates the skill, and sends the remaining
text as the task prompt. This also works for skills with
`disable-model-invocation: true`, which keeps model selection disabled without
blocking manual use.

## Task lifetime

Harnez records a hash of the manifest and file bytes when it creates the task
snapshot. Activation reads `SKILL.md` again and verifies both hashes. If the
file changed, activation fails with `STALE_CAPABILITY`; start a new task to use
the edited version.

The full skill body must fit the model-derived capability-context ceiling. An
activation that does not fit is rejected without evicting another skill. A
manually requested `/name` skill is skipped with a status message so the task
can continue without it.

Model-activated skills remain available for the next model step, then leave
context. Manually requested skills remain until the task ends. Skill bodies and
conversation history share the model input budget for each request.

Only the `SKILL.md` body is admitted automatically. Other files in the skill
directory are not loaded with it.

## Troubleshooting

If a skill does not appear or activate:

1. Check that the file is named `SKILL.md` and sits directly under one of the
   four roots above.
2. Check the YAML frontmatter for a valid `name` or `id` and a non-empty
   `description`.
3. If both `name` and `id` are present, make sure they match.
4. Remove `disable-model-invocation: true` if the model should discover it.
5. Start a new task after adding or editing a skill. Running tasks keep their
   original capability snapshot.

See [Tool discovery](/docs/architecture/tool-discovery) for catalog behavior
and [Task runtime](/docs/architecture/task-runtime) for snapshot lifetime.
