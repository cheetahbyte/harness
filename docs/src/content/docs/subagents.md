---
title: Subagents
slug: advanced/subagents
---

# Subagents

Subagents let a parent task delegate bounded work to background agents. A child
receives its profile, task description, shared workspace, and the capabilities
that its profile allows. It does not receive the parent conversation.

## Create a profile

Harnez scans Markdown profiles from these roots, in this order:

1. `<workspace>/.harnez/agents/*.md`
2. `<workspace>/.harness/agents/*.md`
3. `<workspace>/.agents/agents/*.md`
4. `~/.harnez/agents/*.md`
5. `~/.harness/agents/*.md`
6. `~/.agents/agents/*.md`

The first valid profile for a name wins. An invalid file does not reserve its
name, so a later valid file can define it. Harnez reports later valid duplicates
as shadowed. Built-in profiles have the lowest priority.

A profile uses this frontmatter:

```yaml
---
name: explore
description: Inspect the codebase and report evidence without editing files.
model: openai/gpt-5.6-luna # optional provider/model; otherwise inherit
thinking: medium            # optional
capabilities:
  core: [read, bash]
  skills: []
  mcp: []
---
Inspect first. Report evidence and unresolved questions.
```

The filename supplies `name` when `name` is omitted. Names use lowercase
letters, digits, and hyphens. The supported fields are `name`, `description`,
`model`, `thinking`, and `capabilities`. The model must be a configured
`<provider>/<model>` reference. If `model` is omitted, the child inherits the
parent model; `thinking` overrides the inherited thinking level when present.

Set `capabilities` to `all` or to an object with `core`, `skills`, and `mcp`
arrays. Each explicit name must exist in the task's workspace snapshot. An empty
array grants no capabilities from that category. MCP names must exactly match a
tool name, such as `mcp__github__search_issues`.

Harnez includes two profiles:

- `general-purpose` inherits the parent model and allows all capabilities in
  the finite snapshot created for the child.
- `explore` inherits the parent model and allows only `read` and `bash` core
  tools. It allows no skills or MCP tools.

The `bash` tool is trusted execution and can change the workspace. The
`explore` profile is not a read-only sandbox.

## Delegate work

The parent can run up to 16 nonterminal subagents in one session. Harnez rejects
a seventeenth request before it creates an ID or child lane. Use parallel
`spawn_agent` calls to start a batch.

Use the parent tools as follows:

```text
spawn_agent({ profile, task, description }) -> { id, state: "running" }
get_agent_result({ id, wait: true }) -> terminal PublicSubagentRecord
```

The complete tool set is:

- `spawn_agent` starts an isolated background child.
- `get_agent_result` reads a state immediately or waits for a terminal result.
- `steer_agent` replaces the pending direction for a running child.
- `cancel_agent` requests cancellation of a running child.
- `submit_subagent_result` is available only inside a child and submits its
  validated structured handoff.

Accepted IDs belong to the parent session. Harnez rejects unknown IDs and IDs
from other sessions. You can cancel a waiting result call without cancelling
the child. Cancelling the parent does not cancel its children, and a failed
child does not stop its siblings.

## Results and isolation

Each child has its own context lane. The child receives the profile body, the
explicit task, and a result-reporting instruction, but no parent user,
assistant, reasoning, tool-call, observation, or compacted-history items. The
full child trace remains on that lane. Only one validated `SubagentResult` is
appended to the parent's main lane.

The TUI lists running and cancelling children with their profile, description,
and elapsed time. Terminal children leave the list and add one short completion,
failure, or cancellation notice to the transcript.

Completed handoffs remain available after a restart. If the server restarts
while a child is running, Harnez closes the child lane and returns a failed
result that tells you to start the child again. Harnez does not resume live
execution.

## Current limits

The first release does not include nested subagents, a pending queue, direct
user steering controls, child transcript browsing, resumable child
conversations, worktree isolation, memory, profile colors, fuzzy model
matching, skill preloading, MCP wildcards, or configurable concurrency.
