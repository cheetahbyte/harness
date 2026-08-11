---
title: Tool discovery
slug: architecture/tool-discovery
---

# Tool discovery

Harnez gives each task an immutable catalog snapshot. The catalog currently
contains workspace tools and model-invocable skills. Discovery returns trusted
metadata first, without putting every tool schema or skill body into the model
context.

Core workspace tools are loaded when a task starts. The same discovery path
supports capabilities that are not already loaded.

## Discovery flow

The model-facing operations are:

| Operation | Result |
| --- | --- |
| `capabilities_list` | Lists permitted tools and skills with bounded pagination |
| `capabilities_search` | Searches permitted metadata with the lexical analyzer |
| `capabilities_inspect` | Returns the validated contract for one capability |
| `tools_load` | Admits a tool schema to task context and makes the tool callable |
| `skills_activate` | Verifies and admits a skill body to task context |

A typical dynamic tool flow is:

```text
search -> inspect -> load -> call
```

Skills use `search -> inspect -> activate` instead. Loading or activation can
fail if the task's capability-context budget cannot fit the new content.

## Search behavior

List and search return 20 results by default and accept a limit up to 100.
Longer result sets use a cursor. Search normalizes the query, splits it into
terms, and scores exact names, name terms, tags, descriptions, provider names,
and capability kinds. Equal scores are ordered by canonical capability ID.

The analyzer version is returned as `lexical-v1`. There is no embedding lookup,
second model, or hidden semantic router. A search with no results only means
that the lexical index found no match.

## Identity and authority

Discovery only includes capabilities that are marked model-discoverable and
allowed by the task's grant. Tool authority follows this order:

```text
none < discover < inspect < load < execute
```

Skill authority ends at `activate`. A task can reduce its authority, but it
cannot raise the ceiling after it starts.

Every result carries a versioned reference with a catalog generation, contract
hash, and provider binding generation. Harnez checks that identity again before
loading or executing a tool. A changed contract or missing binding fails with
`STALE_CAPABILITY` instead of running a different implementation under an old
reference.

## Skill discovery

A skill needs valid frontmatter with a `name` or `id` and a `description`.
Skills are model-discoverable by default. Set `disable-model-invocation: true`
to keep a skill available for manual use without exposing it to model
discovery. Harnez hashes the same bytes it uses to parse the manifest.
Activation reads the file again and verifies both the manifest and body hashes
before adding the body to task context.

Invalid manifests are reported as diagnostics and left out of model discovery.

See [Skills](/docs/advanced/skills) for locations, frontmatter, and manual
activation.

See [Task runtime](/docs/architecture/task-runtime) for task snapshots,
cancellation, and capability-context lifetime.
