# Harnez architecture

**Status:** Draft
**Version:** 0.1

## 1. Purpose

Harnez is a personal, terminal-first AI agent harness optimized primarily for software development while remaining general enough for research, university work, and other agentic workflows.

The product direction is intentionally opinionated:

> Claude Code's cohesion and interaction model, pi's simplicity and openness, first-class multi-model support, and architecture tailored to one user's workflows.

Harnez is not intended to become a general-purpose framework or plugin ecosystem. If its opinions happen to work well for other users, they can use it as-is.

## 2. Design principles

### 2.1 Coding-first, not coding-bound

Software development is the primary use case and receives the strongest UX and tooling support.

The underlying runtime should nevertheless avoid assumptions that prevent research, document analysis, data work, or other workflows.

### 2.2 Opinionated over configurable

Harnez optimizes for a specific workflow instead of accommodating every possible preference.

Good internal modularity is desirable. Public extensibility is not a goal.

### 2.3 Model-agnostic

Models are runtime dependencies rather than architectural foundations.

Initial targets:

* Codex through subscription authentication
* OpenAI-compatible endpoints

Additional providers may be supported later.

Models are selected explicitly initially. Automatic routing may be introduced only if it demonstrates practical value.

Different agents within the same session may use different models.

### 2.4 Trusted execution

The agent is trusted to act on behalf of the user.

Harnez does not use approval prompts for ordinary:

* file reads
* file writes
* edits
* shell commands
* tool calls

Control is provided primarily through:

* visibility
* steering
* interruption
* cancellation

Infrastructure-level boundaries may still exist to protect the runtime, credentials, or workspace from accidental misuse.

### 2.5 Context is scarce; execution state is not

Large execution results should not automatically enter the model context.

Harnez separates:

* model context
* runtime state
* persistent session state
* large artifacts

Only information useful for reasoning should cross into the model context.

### 2.6 Interoperable, not extensible

Harnez does not provide a general extension framework.

It does support established interoperability standards where useful, particularly:

* AGENTS.md
* Agent Skills
* Model Context Protocol
* Agent Plugins Specification

These formats feed Harnez's own internal registries and runtime abstractions.

---

## 3. High-level architecture

Harnez uses a local client/server architecture.

```text
┌──────────────────────┐
│      TUI Client      │
└──────────┬───────────┘
           │
       local IPC
           │
┌──────────▼───────────┐
│    Harnez Server    │
│                      │
│  Session Manager     │
│  Agent Runtime       │
│  Subagent Manager    │
│  Context Manager     │
│  Tool Registry       │
│  Skill Registry      │
│  MCP Manager         │
│  Artifact Store      │
│  Persistence         │
└──────────┬───────────┘
           │
┌──────────▼───────────┐
│ Model Runtime Layer  │
│ pi-agent-core /      │
│ pi-ai adapters       │
└──────────────────────┘
```

Operationally, Harnez should still feel like one application.

Running `harnez` should automatically connect to or start the local server as needed.

Remote operation is not an initial requirement.

---

## 4. Runtime

Harnez is implemented in TypeScript and runs on Bun.

The server is a long-lived Bun process.

The TUI may run separately but should remain thin. Expensive session and agent state belongs to the server.

Subagents should normally run as agent instances within the existing runtime rather than spawning a new Bun runtime per agent.

### 4.1 Resource philosophy

Memory usage is an architectural concern.

Harnez should:

* bound caches
* stream large outputs
* externalize completed execution state
* release completed subagent state
* lazily start MCP servers
* avoid retaining full historical transcripts in live objects
* expose memory/resource diagnostics

Large or historical state should preferentially live on disk rather than remain resident in the JS heap.

---

## 5. Model and agent runtime

Harnez should initially build on:

* `@earendil-works/pi-ai`
* `pi-agent-core`

These dependencies provide model integration and basic agent-loop mechanics.

They must remain behind narrow Harnez-owned interfaces.

Pi-specific types and semantics should not propagate throughout the codebase.

Conceptually:

```text
Harnez
   │
   ▼
Harnez runtime interfaces
   │
   ▼
pi-agent-core / pi-ai
   │
   ▼
Provider APIs
```

This allows replacing or diverging from Pi later without redesigning Harnez.

---

## 6. Core agent tools

The permanent tool surface should remain deliberately small.

### Filesystem and execution

* `read`
* `write`
* `edit`
* `bash`

### Dynamic capabilities

* `search_tools`
* `call_tool`
* `batch_tools`

### Subagents

* `spawn_agent`
* `steer_agent`
* `get_agent_result`
* `cancel_agent`

### User interaction

* `ask_user_question`

The model should not receive a large catalog of MCP or specialized tools on every turn.

---

## 7. Progressive tool discovery

`search_tools` searches a unified capability registry containing:

* built-in non-core capabilities
* configured MCP tools
* Agent Plugin-provided MCP tools

Search results return compact capability metadata rather than complete schemas.

Example:

```json
{
  "id": "github.search_issues",
  "name": "Search GitHub issues",
  "description": "Search issues and pull requests.",
  "source": "mcp:github"
}
```

Detailed schemas are loaded only when needed.

`call_tool` executes a discovered capability by stable identifier.

This keeps the permanent prompt/tool surface approximately independent of the total number of available tools.

---

## 8. Batch execution

`batch_tools` executes multiple independent tool calls in one agent step.

Initial semantics should remain simple:

* independent operations may run concurrently
* conflicting mutations must not run concurrently
* Harnez may reject or serialize unsafe combinations
* no dependency graphs
* no embedded workflow language
* no branching or variable binding initially

If more sophisticated tool composition becomes necessary, Harnez should investigate a Code Mode-style execution environment rather than continuously expanding `batch_tools`.

---

## 9. Agent loop and interaction

A normal turn follows:

```text
User message
    ↓
Context construction
    ↓
Model call
    ↓
Tool calls
    ↓
Tool execution
    ↓
Tool results
    ↓
Context construction
    ↓
Model call
    ↓
...
    ↓
Final response
```

A task completes when the model produces a final response without requesting additional actions.

### 9.1 Steering

Harnez distinguishes three user operations.

#### Enter: steer

A normal submitted message modifies the active task.

If the model is generating, generation may be aborted and restarted with the steering message.

If a tool is currently executing, the tool normally completes before the steering message is injected at the next safe boundary.

#### Option + Enter: follow-up

Queues a new task after the current task finishes.

Follow-ups do not alter current-task reasoning.

#### Esc: abort

Cancels the current foreground execution.

Abort should stop:

* active model generation
* cancellable foreground tools
* pending tool calls belonging to the active step

Running subagents remain independent unless explicitly cancelled.

### 9.2 Failures

* transient provider/network failures may be retried automatically
* invalid tool arguments are returned to the model as validation failures
* tool execution failures are returned to the model
* mutating tools are never blindly retried
* runtime invariant failures terminate the affected operation and surface clearly

---

## 10. Subagents

Subagents are first-class isolated agents with predefined profiles.

Example profiles may include:

```text
agents/
  implementer.md
  explorer.md
  reviewer.md
  researcher.md
  compactor.md
```

The parent agent owns:

* global repository exploration
* architecture discovery
* planning
* decomposition
* integration

A delegated subagent owns:

* its supplied work package
* local exploration necessary for that package
* implementation or analysis
* focused verification
* result reporting

### 10.1 Context isolation

A child should not inherit the parent's entire transcript.

Its initial context should be constructed from:

* subagent system/profile instructions
* selected skills
* applicable repository instructions
* explicit task brief
* explicitly delegated files/artifacts/context
* required session metadata

### 10.2 Results

Completed child transcripts remain external to the parent context.

The parent receives a compact result containing information such as:

* status
* changes
* verification performed
* findings
* unresolved issues
* artifact/transcript handle

### 10.3 Concurrency

Independent subagents may run concurrently.

Different subagents may use different models.

---

## 11. Context management

Harnez separates the lossless session history from the bounded working set sent
to a model. `SessionStore` persists immutable context payloads and append-only
episode events in SQLite. A separate lifecycle row records whether each item is
`pinned`, `active`, `retained`, or `archived`, along with its current projection
and the reason for that decision.

`ContextManager` is the Harnez-owned policy boundary. `HarnezAgentRuntime`
remains the only Pi adapter: it persists finalized Pi messages, asks the manager
to assemble every provider request through Pi's context hooks, and replaces the
live Pi transcript with the same managed projection after a turn. Restarting a
server reconstructs context from SQLite rather than from UI event deltas.

System instructions, user-authored messages, and explicit decisions or
constraints created by `pin_context` are mechanically protected. Unknown work
also fails toward retention. If protected content alone cannot fit, Harnez
returns a context-budget error before calling the provider.

Tool output is externalized at creation. SQLite retains the exact observation;
the active model receives a bounded head/tail preview and an
`observation://...` reference. `recall_observation` retrieves an exact,
session-scoped slice without permanently expanding the working set.

Non-trivial work can be labeled as one active `exploration` or `action` episode.
Explorations close with a durable conclusion. Actions declare dependencies on
earlier completed explorations. These append-only boundaries let structural
compaction protect open work and live dependencies without inferring semantics
from raw chat text.

---

## 12. Compaction

Context accounting runs continuously, while physical prompt rewrites are
batched. The high-water budget defaults to the smaller of 80,000 tokens and the
model input window after reserving maximum output. Crossing it triggers one
deterministic cleanup down to an 80% target, reducing prompt-cache churn.

Cleanup first retires completed tool exchanges in a fixed reconstructability
order. If that is insufficient, it archives the oldest completed action
episode. A completed exploration becomes eligible only after every dependent
action is archived; its detailed trace leaves the prompt while its conclusion
remains. Assistant tool calls and results move as one group, and raw payloads
are never rewritten or deleted.

Compact subagent results cross the parent boundary as validated structured
handoffs with external `subagent://...` transcript references. The parent never
imports a child transcript. Until the subagent scheduler exists, tests use a
fake producer against this same boundary.

`GET /sessions/:id/context` exposes projected token cost, lifecycle counts,
episode state, and item-level reasons without returning archived payloads.

LLM-generated historical summaries, arbitrary item-level dependency graphs,
nested episodes, learned policies, and artifact garbage collection remain
future work. They should extend this lifecycle model rather than replace the
immutable event history.

---

## 13. Persistence

Session history is persisted independently of live model context.

### Durable metadata

SQLite should store:

* sessions
* events
* immutable context items and mutable lifecycle projections
* append-only episode events
* agent relationships
* checkpoints
* artifact metadata
* tool metadata where appropriate

The session timeline should conceptually be append-only.

### Resume

A model working set is reconstructed from:

```text
immutable context items
+
current lifecycle projections
+
replayed episode events
```

Completed subagent transcripts persist independently and are referenced by handle.

---

## 14. Artifact storage

Artifacts are divided by durability.

### Ephemeral

Safe to lose.

May use system temporary storage.

### Reconstructable cache

Stored under Harnez cache storage and eligible for aggressive garbage collection.

### Session-critical

Persist until their owning session is deleted or expires.

### User-created output

Lives in the workspace and is never managed as disposable Harnez storage.

Where practical, artifact storage should be content-addressed to avoid duplication.

Retention should be bounded through:

* reference tracking
* configurable size limits
* garbage collection
* LRU eviction for caches
* expiration of old disposable data

---

## 15. Repository instructions

Harnez follows the AGENTS.md convention rather than inventing a Harnez-specific instruction file.

Instructions may exist at:

* repository root
* nested directories

Applicability is determined relative to files being operated on, allowing different parts of a monorepo to carry different instructions.

Harnez runtime configuration remains separate from agent instructions.

---

## 16. Skills

Harnez follows the Agent Skills format.

Skill sources may include:

```text
global user skills
project skills
Agent Plugin skills
```

Skills use progressive disclosure:

1. discover through metadata
2. activate when appropriate
3. load full `SKILL.md`
4. retrieve supporting resources lazily

### 16.1 Invocation

Skills may be:

* explicitly activated by the user through `/skill`
* automatically activated by the model where permitted
* preloaded by a subagent profile

Harnez supports Claude Code-style controls:

```yaml
user-invocable: true
disable-model-invocation: true
```

`disable-model-invocation: true` means the user may invoke the skill but agents may not autonomously activate it.

Explicit authorization may propagate to delegated subagents when appropriate.

Skills normally remain active for the current task rather than accumulating permanently across a session.

---

## 17. Agent plugins

Harnez supports Agent Plugins Specification packages as an interoperability format.

Agent Plugins are not Harnez's architectural extension mechanism.

A package may contribute:

* Agent Skills
* MCP servers

These components feed the same internal registries used by built-in and locally configured capabilities.

Harnez-specific subagent profiles remain outside the portable Agent Plugins v1 component model.

---

## 18. MCP

Harnez reads the Agent Plugins v1.0.0 `mcp.json` format (§7.2, §9) without yet
adopting the surrounding plugin package model. Borrowing only the schema means
that supporting whole plugin packages later is a manifest parser plus a
different root/data pair, rather than a config migration.

Configuration lives at `~/.config/harnez/mcp.json` and `<repo>/.harnez/mcp.json`,
merged by server name with the project file winning. `$schema` is required and
matched by exact string compare; it is never fetched.

The two plugin variables are bound to the config file that declares the server:

| Variable | Value |
| --- | --- |
| `PLUGIN_ROOT` | the directory holding that `mcp.json` |
| `PLUGIN_DATA` | `~/.config/harnez/mcp-data/<server>`, created before launch |

Failures are isolated at the narrowest scope the spec defines: a malformed file
disables MCP for that file alone, a malformed entry skips one server, and a
server that will not start is reported and skipped. Nothing about MCP can
prevent the rest of a session from running.

Discovery is lazy; connections are not:

```text
configuration
     ↓
connect at server start, cache tools/list
     ↓
capability catalog (metadata only)
     ↓
capabilities_search / capabilities_inspect
     ↓
tools_load  →  tool joins the model's tool list
     ↓
call
```

Servers connect eagerly because a task's capability catalog is built from tool
metadata, which cannot be known without a handshake. What stays lazy is the
model's tool list: an MCP tool is a catalog entry until `tools_load` admits it,
so the permanent request surface does not grow with the number of connected
servers. Idle servers may be stopped later to reduce resource use.

An operator can switch a server off from `/mcp`, which disconnects it and stops
its stdio child; switching it back on reconnects immediately, so the menu can
report the outcome instead of deferring it to the next prompt. The exclusions
are stored in `settings.json` as `disabledMcpServers` and consulted on every
connection round. Because connections are process-wide rather than per session,
they are read from the workspace the process started in. A running task keeps
the catalog it was built with.

`sse` is parsed and reported as an unsupported transport, which the
specification permits. Credentials belong in the ambient environment that stdio
servers inherit, never in `env` or `headers`, which are visible configuration.

---

## 19. Configuration

Harnez-specific configuration should remain separate from interoperability files.

Potential structure:

```text
~/.config/harnez/
  config.toml
  skills/
  agents/

<repo>/
  AGENTS.md
  .harnez/
    config.toml
    skills/
    agents/
```

Exact paths and precedence remain to be finalized.

---

## 20. Observability

Harnez should expose enough information to understand its own resource usage and behavior.

Useful diagnostics include:

* server RSS
* JS heap usage
* active agents
* context sizes
* artifact/cache usage
* active MCP processes
* model token usage
* compaction statistics

A `/memory` or equivalent diagnostic command should be considered early rather than added only after resource problems appear.

---

## 21. Non-goals

At least initially, Harnez is not intended to provide:

* a public extension SDK
* a plugin marketplace
* generalized permission/approval workflows
* automatic model routing
* distributed execution infrastructure
* enterprise policy systems
* unlimited long-term semantic memory
* a novel coding interaction model purely for differentiation

---

## 22. Open questions

The following still require concrete design work:

1. Exact client/server IPC protocol and event schema.
2. Daemon startup, shutdown, reconnect, and crash recovery semantics.
3. Exact `search_tools`, `call_tool`, and `batch_tools` schemas.
4. Subagent profile file format.
5. Whether subagents may spawn nested subagents.
6. Default subagent concurrency limits.
7. Compaction thresholds and `fast` / `balanced` / `thorough` / `auto` budgets.
8. SQLite schema and event representation.
9. Artifact retention defaults.
10. Exact global/project configuration hierarchy.
11. MCP idle lifecycle behavior.
12. Whether and when Code Mode-style tool composition should supplement `batch_tools`.
13. TUI rendering and navigation details beyond the steering semantics already established.
14. Research/university-specific first-class capabilities required beyond tools and skills.
