# Task Runtime and Deterministic Capability Control

## Status

Revised design proposal for the first vertical slice.

This version incorporates review feedback around task continuity, cancellation, authority, token accounting, capability identity, and discovery semantics. It intentionally does **not** add semantic retrieval, a general artifact store, autonomous workflow orchestration, or agent spawning.

## Goal

Harness optimizes for **deterministic operator control first** and autonomous task completion second.

The model may reason about which capability it needs. Harness owns deterministic enumeration, discovery, context admission, authorization, scheduling, execution binding, cancellation barriers, and execution evidence.

The system provides deterministic **control-plane semantics around nondeterministic model and provider execution**. It does not claim that model choices, remote providers, network delivery, or remote side effects are deterministic.

## Design target

The first slice targets roughly **10–5,000 model-discoverable capabilities per catalog snapshot**.

At the low end, listing may be sufficient. At the high end, bounded lexical search is required to avoid placing the catalog into model context. Larger catalogs are not a correctness failure, but are outside the initial latency and retrieval-quality target.

## Core invariants

1. **Snapshot** — A task resolves capabilities against one immutable catalog snapshot. Global security revocation always overrides a snapshot.
2. **Identity** — A selected capability is represented by an immutable, versioned reference. Execution proceeds only if the current provider binding still proves the inspected contract identity; otherwise it fails closed.
3. **Authority ceiling** — A task's maximum authority may shrink but never grow. Operator confirmations may resolve authority that was already conditionally granted; they do not widen the ceiling.
4. **Permission ordering** — Capability authority is represented by a validated ordered level, not independent booleans. Higher lifecycle actions imply all lower lifecycle permissions.
5. **Context** — Model-visible capability content is explicit, budgeted, removable, and never survives task termination.
6. **Budget** — Admission uses the best available target-model token accounting method plus an explicit safety margin. Exactness is claimed only when the provider/runtime can actually supply it.
7. **Discoverability** — Every model-discoverable capability permitted by the task can be enumerated and searched without a second model or invisible semantic routing by Harness.
8. **Execution binding** — A tool has a validated typed contract, effect classification, and concrete provider binding. Provider descriptions are discovery metadata, not an execution guarantee or trusted instruction channel.
9. **Ordering** — Queued tasks consume conversation at their submission watermark plus predecessor terminal **user-visible** messages and a bounded control-plane digest. They never inherit intermediate reasoning, tool traffic, or runtime context.
10. **Dependency** — Queue order and success dependency are distinct. A predecessor failure blocks a successor only when the operator explicitly requested success dependency.
11. **Cancellation closure** — Cancellation stops new work but is not rollback. Every started capability call must reach a known terminal outcome or be recorded as `outcome_unknown` before the task is considered quiescent.
12. **Supersede safety** — Stop-and-send may accept the replacement request immediately, but the replacement runtime does not begin until the superseded runtime reaches the cancellation barrier. Its terminal digest is handed to the replacement.
13. **Execution evidence** — Model prose and terminal messages are semantic context, not execution evidence. Only Harness-authored ledger events establish control-plane facts.
14. **Cross-task disclosure** — A handoff exposes only ordinary user-visible conversation plus control-plane facts the successor is currently authorized to observe.

## Scope of the first vertical slice

Implement only:

```text
TaskRuntime
├─ immutable capability snapshot and provider bindings
├─ monotonic authority ceilings and confirmation state
├─ ContextItem admission/removal
├─ model-aware token accounting with safety margin
├─ append-only execution ledger
├─ cancellation/quiescence barrier
├─ predecessor terminal projection
└─ deterministic task state

Scheduler
├─ steer
├─ queue
├─ optional success dependency
├─ supersede
└─ predecessor blocking when explicitly required

Capability discovery
├─ metadata-only skill discovery
├─ deterministic bounded list/search/inspect
├─ tool load path
└─ skill activate path
```

Explicit non-goals:

- embeddings, rerankers, synthetic intentions, or learned routing;
- a hierarchy/namespace as a correctness requirement;
- a content-addressed skill-body cache;
- a general artifact store or cross-task artifact API;
- agent registry/spawn lifecycle integration;
- automatic context eviction;
- arbitrary model access to the execution ledger;
- concurrent top-level task execution in one conversation;
- transactional rollback of remote side effects.

## Runtime boundary

A chat session persists conversation information. A `TaskRuntime` owns execution state for one top-level request and its explicit steers.

```text
chat session
├─ TaskRuntime A
│  ├─ top-level request
│  ├─ model/tool/skill steps
│  └─ steers
├─ TaskRuntime B
└─ user-visible conversation history
```

A runtime starts when Harness accepts a top-level request for execution.

```ts
type TaskTerminalStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "superseded"

type TaskState =
  | "running"
  | "cancelling"
  | "quiescing"
  | "terminal"
```

A completed runtime never silently affects the capability environment of a later task. A later request receives ordinary conversation continuity but a new snapshot, new authority decision, new provider bindings, and no inherited capability context.

All `ContextItem`s are destroyed at task termination.

## Task state and scheduling

Message text and model interpretation never create, merge, supersede, or extend task boundaries.

```text
No active runtime + normal submit  → create task
Active runtime + steer action      → continue same runtime
Active runtime + normal submit     → queue
Explicit stop-and-send             → supersede
```

Initial operations:

```ts
task.steer(activeTaskId, message)
task.enqueue(message, { requirePredecessorSuccess?: boolean })
task.supersede(activeTaskId, message)
```

Only one top-level task is active per conversation initially.

### Queue order is not success dependency

A queued request records when the user submitted it and, if applicable, which active task precedes it.

```ts
type QueuedTask = {
  submissionWatermark: ConversationRevision
  predecessorTaskId?: TaskId
  requirePredecessorSuccess: boolean
  userInput: Message
}
```

The default ordinary send while a task is active is:

```text
queue after predecessor terminalization
requirePredecessorSuccess = false
```

This means an unrelated queued message is not blocked merely because the prior task failed.

An explicit operator action may set:

```text
requirePredecessorSuccess = true
```

If so, predecessor status `failed`, `cancelled`, or `superseded` produces `BLOCKED_BY_PREDECESSOR` until the operator resumes, cancels, or replaces the queued item.

Harness does not infer success dependency from message text.

## Predecessor terminal projection

A successor must retain user-visible semantic continuity without inheriting predecessor execution state.

At runtime creation Harness assembles:

```text
conversation through submission watermark
+ predecessor terminal user-visible message(s)
+ predecessor control-plane digest
+ current catalog snapshot and grants
→ new TaskRuntime
```

The predecessor terminal user-visible message is ordinary conversation context and is explicitly **advisory**. It may say what the predecessor believes it changed, but the successor must re-read or revalidate external/workspace state before relying on those claims for further side effects.

The successor never receives:

- predecessor reasoning;
- intermediate assistant scratch messages;
- raw tool requests or responses;
- predecessor `ContextItem`s;
- full execution ledger;
- hidden provider metadata;
- predecessor capability refs that the successor cannot itself discover.

This projection also applies to **superseded** predecessors.

## Cancellation, supersede, and quiescence

Cancellation is a control-plane request, not rollback.

When cancellation begins:

1. the task enters `cancelling`;
2. Harness starts no new capability calls for that task;
3. cancellation is propagated to in-flight providers where supported;
4. each already-started call must receive a terminal ledger event;
5. the task enters `quiescing` until all in-flight calls are terminal;
6. if the provider cannot prove an outcome, Harness records `outcome_unknown`;
7. only then does the task become terminal.

A superseding request may be accepted immediately, but its runtime does not start until this barrier is complete.

### Capability call outcomes

```ts
type CapabilityCallOutcome =
  | "success"
  | "failure"
  | "cancelled_before_start"
  | "cancelled_acknowledged"
  | "outcome_unknown"
```

`cancelled_acknowledged` means the provider acknowledged cancellation before reporting success or failure. It does **not** imply rollback unless the provider contract explicitly guarantees rollback semantics.

### Effect classification

Every executable tool contract has a Harness-controlled effect classification:

```ts
type EffectClass =
  | "read_only"
  | "mutating"
```

Unknown or provider-untrusted classifications default to `mutating`.

The classification is part of the inspected contract identity and therefore covered by `contractHash`.

The first slice does not attempt fine-grained resource-conflict analysis.

If a predecessor terminates with one or more `outcome_unknown` mutating calls, the successor may perform read-only work but mutating execution is held behind an explicit operator acknowledgement of the unknown prior effect state.

## Capability snapshots and identity

Snapshots freeze:

- catalog metadata;
- validated contracts;
- effect classifications;
- policy decisions;
- provider binding references;
- metadata trust state.

They do not freeze remote provider behavior.

### Capability reference

```ts
type CapabilityRef = {
  id: string
  catalogGeneration: string
  contractHash: string
  providerBinding: ProviderBindingRef
}
```

`id` is unique within the catalog generation. Provider-local names are namespaced or otherwise canonicalized by the catalog before becoming an `id`; correctness never depends on the provider supplying globally unique names.

### Provider binding

```ts
type ProviderBindingRef = {
  providerId: string
  bindingGeneration: string
}
```

A binding generation identifies one Harness-established executor session/configuration generation.

For the first slice, a provider reconnect, restart, credential-principal change, executor configuration change, or contract-set refresh creates a **new binding generation**. This is intentionally conservative.

Credentials themselves are never stored in the snapshot. A snapshot may store a credential-binding identity that must still resolve through the current credential authority at execution time.

At execution Harness checks:

```text
snapshot permits?
AND current security state permits?
AND provider binding generation still exists?
AND current bound contract hash == inspected contractHash?
→ execute
```

Any mismatch fails closed with `STALE_CAPABILITY` or an authorization/binding error as appropriate.

Global revocation, disabled providers, and revoked credentials override a snapshot.

A catalog refresh creates a new generation for future tasks. It never mutates a running task or replaces capability generations already present in active context.

## Structured hashing

Hash semantics are versioned.

```ts
type HashScheme =
  | "raw-sha256-v1"       // byte identity, e.g. SKILL.md body
  | "jcs-sha256-v1"       // canonical structured identity
  | "jcs-hmac-sha256-v1"  // sensitive structured evidence
```

For v1:

- raw file identity hashes the exact byte buffer consumed;
- structured capability contracts are normalized and serialized with one canonical JSON scheme before hashing;
- sensitive tool input/output evidence uses a keyed HMAC over canonicalized/redacted data rather than a raw public hash.

The hash scheme identifier is stored anywhere a persisted hash may outlive the current process.

## Authority model

Independent booleans are not used for lifecycle permissions.

### Tool authority

```ts
type ToolAuthorityLevel =
  | "none"
  | "discover"
  | "inspect"
  | "load"
  | "execute"

type ConfirmationPolicy =
  | "none"
  | "confirm_each"
  | "confirm_once"

type ToolGrant = {
  maxLevel: ToolAuthorityLevel
  confirmation: ConfirmationPolicy
}
```

The ordering is:

```text
execute > load > inspect > discover > none
```

Therefore `execute` necessarily includes permission to load, inspect, and discover.

`load` without `execute` is coherent: the model may inspect/admit a schema without being allowed to call it.

### Skill authority

```ts
type SkillAuthorityLevel =
  | "none"
  | "discover"
  | "inspect"
  | "activate"

type SkillGrant = {
  maxLevel: SkillAuthorityLevel
}
```

The ordering is:

```text
activate > inspect > discover > none
```

### Monotonic authority ceiling

Within one runtime:

```text
maxAuthority(t + 1) ≤ maxAuthority(t)
```

A steer may reduce the ceiling but cannot widen it.

Interactive approval does not violate this invariant. A tool pre-granted as:

```ts
{
  maxLevel: "execute",
  confirmation: "confirm_each"
}
```

already contains conditional execute authority. Operator confirmation resolves the condition for that call; it does not raise `maxLevel`.

If the task began with `maxLevel: "inspect"`, a later request such as “deploy it now” cannot widen the task to `execute`. It must become a new task with a fresh authorization decision.

This trade-off is intentional: **interactive approval works only within the task's pre-authorized ceiling**.

When agents are added later, child authority is bounded by:

```text
parent authority ceiling
∩ agent declared maximum
∩ explicit delegation policy
= child authority ceiling
```

No implicit inheritance is allowed.

## Context lifecycle

A loaded tool schema or activated skill body is an owned context resource, not pinned prompt mutation.

```ts
interface ContextItem {
  id: string
  owner: "capability"
  capability: CapabilityRef
  scope: "step" | "task"
  contentHash: string
  content: ModelContextContent
}
```

There is no `manual` lifetime in the first slice.

A task-scoped item may be explicitly removed early, but all context is removed automatically at task termination.

Every model invocation, including steers and follow-ups, is assembled by the same context manager. No direct prompt reconstruction path may bypass this lifecycle.

## Token accounting and admission

Token cost is not an intrinsic field of `ContextItem`.

Accounting is computed for the **assembled target-model request** and is bound to the target model and serialization strategy.

### Accounting result

```ts
type TokenAccounting = {
  modelId: string
  serializerVersion: string
  method:
    | "local_exact"
    | "provider_count"
    | "conservative_estimate"
  estimatedInputTokens: number
  safetyMarginTokens: number
  admittedInputCeiling: number
}
```

Harness claims exactness only for `local_exact` or a provider counting API whose documented semantics match the submitted request representation closely enough for that provider adapter to declare exactness.

Otherwise admission is conservative:

```text
estimatedInputTokens
+ safetyMarginTokens
≤ configured capability/context budget
```

Initial configurable defaults:

```text
core capability context     target ≤ 2k tokens
loaded dynamic context      target ≤ 6k tokens
----------------------------------------------
capability/context budget   target ≤ 8k tokens
```

These are admission targets, not claims about exact provider-side billing tokens.

### Load/activation transaction

```text
render full request as Harness intends to submit it
→ account using target-model adapter
→ add configured safety margin
→ calculate resulting context state
→ ADMITTED
  or REJECTED {
       estimatedRequiredTokens,
       availableTokens,
       safetyMarginTokens,
       evictionCandidates
     }
```

Harness initially returns an eviction plan but never silently evicts context.

### Provider reconciliation

After each provider response, Harness records provider-reported input usage when available and compares it with the prior estimate/count.

Telemetry records absolute and percentage divergence. Provider adapters may increase their future safety margin when observed divergence exceeds a configured threshold.

Post-hoc provider usage is reconciliation data; it cannot retroactively make an over-budget call safe.

### Model switching

Changing the target model invalidates prior token accounting.

Before the next model call Harness must re-account the full assembled context under the new model adapter. If the new model does not fit, the switch is rejected or the normal explicit eviction flow is invoked.

## Deterministic capability discovery

The registry unifies discovery metadata, not lifecycle semantics.

```text
tool   → inspect → load → call
skill  → inspect → activate
agent  → inspect → spawn  (later)
```

Model-facing primitives are intentionally kind-aware:

```ts
capabilities.list(options)
capabilities.search(query, options)
capabilities.inspect(ref)

tools.load(ref)
skills.activate(ref)
```

A loaded tool becomes callable through the normal tool-call mechanism only if the task grant reaches `execute` and any confirmation condition is satisfied.

### Bounded list/search

`list` and `search` are bounded and paginated. They never dump the full catalog into model context by default.

Initial lexical search indexes:

- canonical capability name;
- operator-approved description;
- tags;
- provider display name;
- capability kind.

No second model, embedding lookup, generated intention, or hidden semantic router participates.

### Reproducibility

The lexical analyzer is versioned. Within one catalog generation and analyzer version, Harness defines:

- Unicode normalization;
- tokenization;
- field weighting;
- score calculation;
- stable tie-break by canonical capability id;
- result limit/pagination semantics.

A search returning no match means only that the installed lexical index found no match. It does not prove the task is impossible.

Namespaces may be useful presentation metadata, but correctness never depends on providers maintaining a hierarchy.

Semantic retrieval, embeddings, reranking, generated intentions, and set-aware retrieval remain future optimizations gated by telemetry.

## Metadata trust boundary

Capability metadata is model input and therefore part of the prompt-injection threat surface.

```ts
type MetadataTrust =
  | "harness"
  | "operator_approved"
  | "provider_untrusted"
```

For the first slice:

- Harness-authored metadata is model-discoverable.
- Operator-approved provider metadata may be model-discoverable after validation and size limits.
- `provider_untrusted` arbitrary descriptions are **not** exposed verbatim to the model by default.
- Untrusted providers may remain operator-visible while model discovery is disabled for them.

Provider-supplied descriptions never override system policy, grant state, effect classification, execution contract identity, or confirmation policy.

## Skills: metadata-only discovery and byte-verified identity

A model-discoverable skill must have explicit, validated, operator-controlled metadata.

```ts
type SkillDiscoveryState =
  | "discoverable"
  | "operator_only"
  | "invalid"
```

```text
valid manifest + modelInvocable: true   → discoverable
valid manifest + modelInvocable: false  → operator_only
missing/invalid required metadata       → invalid
                                          exclude from model list/search
                                          report to operator diagnostics
```

Minimal frontmatter:

```yaml
---
id: git-review
description: Review repository changes
modelInvocable: true
---
```

Tags are optional.

An offline/operator migration utility may propose manifests for legacy skills, but explicit acceptance is required before model discovery.

### Snapshot identity

Snapshotting reads `SKILL.md` **once** into a byte buffer.

From that same buffer Harness:

1. parses validated frontmatter metadata;
2. hashes the raw bytes for body identity;
3. stores the resulting reference.

```ts
type SkillRef = {
  id: string
  catalogGeneration: string
  manifestHash: string
  bodyHash: string
}
```

Activation likewise reads the file **once**:

```text
read SKILL.md into one buffer
→ verify bodyHash over that buffer
→ mismatch: STALE_CAPABILITY
→ match: parse body from the verified buffer
→ account tokens
→ attempt ContextItem admission
```

This removes a read/verify/parse TOCTOU gap.

### Development mode

Development mode may watch skill files and automatically refresh the **next** catalog generation after edits. It never mutates the snapshot of an already-running task.

An edit during an active task therefore still produces `STALE_CAPABILITY` for that task; the developer can restart the task against the refreshed generation.

## Execution ledger

The execution ledger is Harness-authored, append-only control-plane state.

It is event-shaped rather than represented by mutable completed entries.

```ts
type ExecutionLedgerEntry =
  | {
      type: "capability_call_started"
      callId: CallId
      capability: CapabilityRef
      effect: EffectClass
      startedAt: Timestamp
      inputEvidence?: EvidenceDigest
    }
  | {
      type: "capability_call_finished"
      callId: CallId
      outcome: CapabilityCallOutcome
      finishedAt: Timestamp
      outputEvidence?: EvidenceDigest
    }
  | {
      type: "grant_reduced"
      capabilityId: string
      before: AuthoritySummary
      after: AuthoritySummary
      at: Timestamp
    }
  | {
      type: "cancellation_requested"
      at: Timestamp
    }
```

The ledger must not blindly retain raw arbitrary tool output, secrets, credentials, or full filesystem contents.

Model prose and terminal assistant messages are never execution evidence.

## Task terminal result

```ts
type TaskTerminalResult =
  | {
      status: "completed"
      terminalMessageIds: MessageId[]
    }
  | {
      status: "failed"
      error: TaskFailure
      terminalMessageIds: MessageId[]
    }
  | {
      status: "cancelled"
      terminalMessageIds: MessageId[]
    }
  | {
      status: "superseded"
      terminalMessageIds: MessageId[]
    }
```

`terminalMessageIds` point into ordinary chat conversation. Their contents are semantic/advisory context, not evidence.

## Successor control-plane digest

A successor does not receive the full ledger.

At successor creation Harness computes a redacted, token-bounded digest against **the successor's current grants**.

```ts
type TaskLedgerDigest = {
  status: TaskTerminalStatus
  capabilityCalls: number
  failedCalls: number
  successfulMutatingCalls: number
  unknownMutatingCalls: number
  cancelledCalls: number
  referencedCapabilities: SafeCapabilitySummary[]
  startedAt: Timestamp
  finishedAt: Timestamp
}
```

`SafeCapabilitySummary` may contain only facts already discoverable by the successor.

The digest contains no:

- hidden capability names;
- provider binding identities;
- raw capability refs;
- filesystem paths;
- raw hashes/HMAC values;
- model prose;
- tool output;
- arbitrary provider metadata.

The full ledger remains operator/control-plane data. There is no model-facing `inspect_task_ledger` operation in the first slice.

## Why there is no artifact subsystem yet

There is still no demonstrated need for a general cross-task artifact system in the first slice:

- subagent output is future intra-task parent/child communication;
- a later “fix it” task should re-read current repository/workspace state under fresh authorization;
- workspace files are accessed through newly authorized capabilities;
- ordinary tool output should be rediscovered or revalidated rather than smuggled across task boundaries;
- semantic continuity comes from terminal user-visible messages;
- execution truth comes from the bounded control-plane digest.

Introduce an artifact system only when a successor needs state that cannot reasonably be reconstructed or re-read through newly authorized capabilities—for example a large generated binary, expensive captured trace, disappearing sandbox output, or immutable patch requiring exact provenance.

## Initial observability

Operator-visible state should include:

- task id and state;
- catalog generation;
- provider binding generations;
- active capability context;
- authority ceilings and confirmation state;
- token estimate method and safety margin;
- admission/rejection decisions;
- execution status;
- cancellation/quiescence state;
- unknown mutating outcomes;
- predecessor dependency state.

Initial telemetry should measure:

```text
search success rate
search → selected capability rate
mean searches per task
list/search result counts
schema/context tokens per task
loaded capabilities never used
discovery-caused task failures
STALE_CAPABILITY failures
provider binding invalidations
confirmation prompts / approvals / denials
token estimate vs provider usage divergence
cancellations with successful mutating effects
cancellations with unknown mutating outcomes
successor blocks caused by explicit success dependency
```

These measurements—not paper benchmarks alone—determine whether semantic discovery, caching, hierarchy changes, automatic eviction, richer effect/resource modeling, or artifacts become worthwhile.

## Implementation order

1. **Skeleton `TaskRuntime` and one model-invocation boundary.** Route top-level requests, steers, follow-ups, and future scheduler paths through one runtime-owned assembly/execution seam.
2. **Define capability/provider identity.** Add minimal capability objects, canonical ids, provider binding generations, contract hashing, and effect classification.
3. **Add immutable catalog snapshots and authority ceilings.** Implement ordered grant validation plus confirmation state.
4. **Add append-only execution ledger and cancellation barrier.** Make every tool call event-shaped before introducing supersede behavior.
5. **Add first-class `ContextItem` lifecycle and token accounting.** Remove pinned prompt mutation; add target-model accounting, margins, model-switch re-accounting, and explicit removal.
6. **Move current hard-coded tools behind provider-bound capability objects.** Enforce contract-hash validation at execution.
7. **Add metadata-only skill discovery.** Use one-buffer snapshot/activation hashing and separate `skills.activate` semantics.
8. **Add deterministic bounded `list`, lexical `search`, and `inspect`; add `tools.load`.** Version normalization/ranking/tie-breaking.
9. **Add queue/steer/supersede.** Implement predecessor terminal message projection, successor digest, explicit success dependency, and cancellation/quiescence handoff.
10. **Add agents, semantic retrieval, artifacts, automatic eviction, or learned policy only when a concrete workflow and telemetry justify each one.**

## Current integration constraints

The current implementation has seams that must change before this model can hold:

- tools are hard-coded rather than registered through a runtime capability layer;
- skill discovery eagerly reads full skill bodies, so it cannot serve a metadata-only model tier unchanged;
- skill activation behaves like pinned prompt mutation rather than owned/removable task context;
- follow-up and streaming-steer paths do not all go through one capability/context assembly path;
- cancellation does not yet have a call-outcome/quiescence model;
- provider binding generations and effect classifications do not yet exist;
- there is no agent registry/spawning lifecycle to unify with the registry yet.

Therefore this remains more than a registry refactor. The first necessary abstraction is a runtime-owned execution boundary with explicit task state, capability identity, authority, context lifecycle, and ledger semantics. Discovery is built on top of those guarantees.

## First-slice acceptance tests

The architecture is not considered implemented until at least these behaviors hold:

1. A queued “now write tests for it” request can see the predecessor's final user-visible response but not its tool traffic or reasoning.
2. An unrelated queued task still runs after predecessor failure when `requirePredecessorSuccess = false`.
3. A success-dependent queued task blocks after predecessor failure/cancellation/supersede.
4. Stop-and-send cannot start replacement mutations while predecessor calls remain unresolved.
5. A cancelled task with a successful mutating call reports that fact in the successor digest.
6. A cancelled task with an unknowable mutating outcome blocks successor mutations pending operator acknowledgement.
7. A tool contract changed after inspection cannot execute under the old `CapabilityRef`.
8. A provider reconnect creates a new binding generation and invalidates old execution bindings.
9. A confirmation prompt can authorize a conditionally pre-granted execute action without increasing the task authority ceiling.
10. A task that began with inspect-only authority cannot become execute-authorized through a steer.
11. A model switch re-accounts all active context before another call is sent.
12. A skill edit between snapshot and activation fails with `STALE_CAPABILITY`; snapshot and activation each hash and parse one identical byte buffer.
13. No `ContextItem` survives task termination.
14. Search ordering is reproducible for one catalog generation and analyzer version.
15. Provider-untrusted metadata cannot become verbatim model-discovery context without operator approval.

