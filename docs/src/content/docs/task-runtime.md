---
title: Task runtime
slug: architecture/task-runtime
---

# Task runtime

A chat session keeps the conversation. A task runtime owns the execution state
for one top-level request and any explicit steers sent while it is running.
Only one top-level task runs in a session at a time.

## Task boundaries

Harnez handles operator input according to the requested action:

| Action | Behavior |
| --- | --- |
| Start | Creates a task when no task is active |
| Steer | Adds input to the active task |
| Follow-up | Waits in the queue for the active task to finish |
| Supersede | Cancels the active task, then starts its replacement |

A follow-up does not depend on its predecessor succeeding unless the operator
sets that requirement. A success-dependent follow-up stays blocked after a
failed, cancelled, or superseded predecessor until the operator resumes,
cancels, or replaces it.

## Fresh capability state

Each new task gets a fresh capability catalog snapshot, provider bindings,
grants, and capability context. Loaded tool schemas are task-scoped. Skills
activated by the model are step-scoped and leave context after one model step;
skills activated directly with `/name` remain until the task terminates.

The runtime checks a capability's catalog generation, contract hash, provider
binding, grant, and load state before execution. A global revocation or disabled
provider still overrides the snapshot. See
[Tool discovery](/docs/architecture/tool-discovery) for the list, search,
inspect, load, and activation flow.

Tool grants use ordered authority from `discover` through `execute`. Skill
grants run from `discover` through `activate`. The ceiling can shrink during a
task but cannot grow. A confirmation satisfies a condition on an existing
execute grant; it does not add authority.

Capability admission uses a ceiling derived from the model's usable input
budget. Harnez accounts for active capability items and a minimal model base,
adds a safety margin, and either admits the item or reports its estimated need,
the margin, and the ceiling. Final request assembly charges injected capability
content and conversation history against the same input budget. Harnez does not
silently evict a loaded schema or skill body; a directly requested skill that
does not fit is skipped with a status message instead of failing the task.

## Cancellation

Task state moves through `running`, `cancelling`, `quiescing`, and `terminal`.
Cancellation stops new capability calls and sends abort signals to calls that
are already running. The runtime waits for each started call to finish, receive
a cancellation acknowledgement, or reach `outcome_unknown` after the grace
period. Superseding work starts only after this barrier.

Cancellation does not roll back side effects. If a mutating call ends with an
unknown outcome, the successor can still perform read-only work, but new
mutations wait for explicit acknowledgement.

## What a successor receives

The runtime records capability calls, grant reductions, and cancellation in an
append-only ledger. Input and output evidence is redacted and stored as keyed
digests rather than raw tool data.

A queued or superseding successor receives the conversation through its
submission point, the predecessor's final user-visible message, and a redacted
control-plane digest. The digest includes call counts, terminal status, and
only capability names the successor may discover. It does not include the
predecessor's reasoning, tool traffic, full ledger, provider bindings, or
capability context.

Conversation history has a separate lifecycle. See
[Context compaction](/docs/architecture/context-compaction) for observations,
episodes, and deterministic eviction.
