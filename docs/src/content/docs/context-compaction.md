---
title: Context compaction
slug: architecture/context-compaction
---

# Context compaction

An agent can fill its context window quickly. File reads and test logs may be
useful for one turn, while user instructions may need to stay available for the
entire session. Sending all of that history back to the model on every turn
wastes tokens and eventually stops fitting.

Harnez keeps the full session history separate from the smaller conversation
context it sends to the model:

```text
event log       = complete source of truth
model context   = bounded working set for the next turn
observations    = exact tool output stored outside the working set
repository      = durable result of completed actions
```

Only the model-facing working set is compacted. The event log, exact tool
output, and workspace files remain intact. Loaded tool schemas and activated
skill bodies use a separate, task-owned context described in
[Task runtime](/docs/architecture/task-runtime).

## Context lifecycle

Each stored conversation item moves through one of four states:

| State | What it contains | Can it leave the working set? |
| --- | --- | --- |
| `pinned` | User messages, system rules, explicit constraints, and durable decisions | No |
| `active` | The current turn and any open work episode | Not while active |
| `retained` | Completed turns and tool exchanges that may still help | Yes, when the budget is exceeded |
| `archived` | History kept in storage but represented compactly or omitted from the next model request | Already removed |

Harnez pins unknown item types rather than guessing that they are safe to
remove. If the protected content alone exceeds the budget, it reports an error
before making a model request.

## Tool output and observations

When a tool finishes, Harnez copies its exact output into an observation. Each
observation has an address:

```text
observation://obs-7c2f...
```

The model sees the result directly at first. If the result is large, it gets the
beginning and end with the observation address between them. After the exchange
is no longer active, Harnez can replace it with a short reference:

```text
Earlier read output was compacted.
Full output: observation://obs-7c2f...
```

The model can use `recall_observation` to read an exact slice of the archived
output. The observation URI accepts `offset` and `limit` query parameters, so a
targeted read looks like this:

```text
observation://obs-7c2f...?offset=12000&limit=4000
```

## Episodes and dependencies

For non-trivial work, the agent marks where an episode starts and ends:

- An `exploration` episode gathers information. It must end with a concise
  conclusion.
- An `action` episode changes the environment. It must name the completed
  exploration episodes it depends on.

```text
exploration: inspect-auth
  read auth.ts
  inspect callers
  inspect tests
  conclusion: JWT validation runs before route dispatch

action: fix-auth
  depends on: inspect-auth
  edit auth.ts
  run tests
```

The dependency records why an action was taken. Harnez can keep the relevant
investigation around until the action that used it has also been archived.

## Eviction order

Before each model request, Harnez recalculates the conversation working set and
includes the fixed cost of the permanent tool definitions. The default
conversation budget is whichever is smaller: 80,000 tokens or the model's
usable input window. Once the working set crosses that limit, Harnez reduces it
toward 80 percent of the budget.

For session history, it removes context in two passes:

1. Completed tool exchanges are compacted first. Writes and edits have early
   priority because their effects already exist in the repository. Reads use
   normal priority, while shell output and errors are kept longer.
2. If that is not enough, Harnez archives completed episodes. Action episodes
   go first. An exploration remains available until the actions that depend on
   it have been archived.

Archiving an exploration removes its detailed trace from the working set. Its
conclusion and observation addresses stay. Harnez never considers an active
episode or pinned item for eviction.

For each stored conversation item, the context manager records its state,
projection, token cost, and the reason it was evicted. This information is
available from `GET /sessions/:id/context`.

## Task capability context

Tool schemas and activated skill bodies do not follow the conversation
lifecycle above. They belong to one task and have either `step` or `task`
scope. Harnez admits them against a separate 8,000-token ceiling with a
512-token safety margin.

If an item does not fit, admission fails and reports the current items that
could be removed. Harnez does not evict capability context automatically. It
clears all remaining capability items when the task ends, so a later task gets
a fresh capability snapshot and context.

## Subagent handoffs

The parent receives a structured result instead of the subagent's full trace.
The handoff contains its status, findings, decisions, changed files,
verification, unresolved issues, and artifact references. The parent keeps the
result it needs without adding every intermediate step to its own context.

## Related work

The closest reference for Harnez's eviction model is
[Beyond Compaction: Structured Context Eviction for Long-Horizon Agents](https://arxiv.org/html/2606.11213v1).
Its Context Window Lifecycle design uses typed episodes, explicit dependencies,
and token accounting to choose what to evict without another model call.

[Context as a Tool: Context Management for Long-Horizon SWE-Agents](https://arxiv.org/abs/2512.22087)
takes a different approach. CAT divides the workspace into stable task
semantics, condensed long-term memory, and recent high-fidelity interactions. A
trained agent chooses when to compress older history. Harnez does not use that
learned compressor. Its eviction rules are deterministic, and archived
explorations keep the conclusions written by the agent.
