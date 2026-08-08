# Harness Architecture

**Status:** Draft
**Version:** 0.1

## 1. Purpose

Harness is a personal, terminal-first AI agent harness optimized primarily for software development while remaining general enough for research, university work, and other agentic workflows.

The product direction is intentionally opinionated:

> Claude Code's cohesion and interaction model, pi's simplicity and openness, first-class multi-model support, and architecture tailored to one user's workflows.

Harness is not intended to become a general-purpose framework or plugin ecosystem. If its opinions happen to work well for other users, they can use it as-is.

## 2. Design Principles

### 2.1 Coding-first, not coding-bound

Software development is the primary use case and receives the strongest UX and tooling support.

The underlying runtime should nevertheless avoid assumptions that prevent research, document analysis, data work, or other workflows.

### 2.2 Opinionated over configurable

Harness optimizes for a specific workflow instead of accommodating every possible preference.

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

Harness does not use approval prompts for ordinary:

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

Harness separates:

* model context
* runtime state
* persistent session state
* large artifacts

Only information useful for reasoning should cross into the model context.

### 2.6 Interoperable, not extensible

Harness does not provide a general extension framework.

It does support established interoperability standards where useful, particularly:

* AGENTS.md
* Agent Skills
* Model Context Protocol
* Agent Plugins Specification

These formats feed Harness's own internal registries and runtime abstractions.

---

## 3. High-Level Architecture

Harness uses a local client/server architecture.

```text
┌──────────────────────┐
│      TUI Client      │
└──────────┬───────────┘
           │
       local IPC
           │
┌──────────▼───────────┐
│    Harness Server    │
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

Operationally, Harness should still feel like one application.

Running `harness` should automatically connect to or start the local server as needed.

Remote operation is not an initial requirement.

---

## 4. Runtime

Harness is implemented in TypeScript and runs on Bun.

The server is a long-lived Bun process.

The TUI may run separately but should remain thin. Expensive session and agent state belongs to the server.

Subagents should normally run as agent instances within the existing runtime rather than spawning a new Bun runtime per agent.

### 4.1 Resource philosophy

Memory usage is an architectural concern.

Harness should:

* bound caches
* stream large outputs
* externalize completed execution state
* release completed subagent state
* lazily start MCP servers
* avoid retaining full historical transcripts in live objects
* expose memory/resource diagnostics

Large or historical state should preferentially live on disk rather than remain resident in the JS heap.

---

## 5. Model and Agent Runtime

Harness should initially build on:

* `@earendil-works/pi-ai`
* `pi-agent-core`

These dependencies provide model integration and basic agent-loop mechanics.

They must remain behind narrow Harness-owned interfaces.

Pi-specific types and semantics should not propagate throughout the codebase.

Conceptually:

```text
Harness
   │
   ▼
Harness runtime interfaces
   │
   ▼
pi-agent-core / pi-ai
   │
   ▼
Provider APIs
```

This allows replacing or diverging from Pi later without redesigning Harness.

---

## 6. Core Agent Tools

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

## 7. Progressive Tool Discovery

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

## 8. Batch Execution

`batch_tools` executes multiple independent tool calls in one agent step.

Initial semantics should remain simple:

* independent operations may run concurrently
* conflicting mutations must not run concurrently
* Harness may reject or serialize unsafe combinations
* no dependency graphs
* no embedded workflow language
* no branching or variable binding initially

If more sophisticated tool composition becomes necessary, Harness should investigate a Code Mode-style execution environment rather than continuously expanding `batch_tools`.

---

## 9. Agent Loop and Interaction

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

Harness distinguishes three user operations.

#### Enter — steer

A normal submitted message modifies the active task.

If the model is generating, generation may be aborted and restarted with the steering message.

If a tool is currently executing, the tool normally completes before the steering message is injected at the next safe boundary.

#### Option + Enter — follow-up

Queues a new task after the current task finishes.

Follow-ups do not alter current-task reasoning.

#### Esc — abort

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

## 11. Context Management

Harness uses a hybrid context model.

### Always resident

Typically:

* Harness/system instructions
* current task
* critical task constraints
* applicable project instructions
* active skills
* active working state
* recent conversational context

### Dynamically retrieved

Examples:

* relevant file content
* discovered tool schemas
* old artifacts
* earlier session information
* research material

### Externalized

Examples:

* large command output
* full API responses
* completed subagent transcripts
* old file snapshots
* historical tool results

Large results become addressable artifacts rather than automatically becoming conversation messages.

---

## 12. Compaction

Compaction uses four stages.

### Extract

Harness deterministically catalogs relevant ground truth, including:

* files
* errors
* commands
* decisions
* constraints
* topics
* artifact references
* subagent state
* open loops
* unresolved questions
* relevant metadata

### Explore

Optional.

Used in `thorough` mode or when `auto` determines that additional reconstruction is needed.

Cheaper modes rely primarily on deterministic boundaries.

### Synthesize

A predefined `compactor` subagent produces the compact continuation state.

The compactor profile may be overridden.

Synthesis may use adaptive single-pass or bounded hierarchical processing with explicit token/call/output budgets.

### Verify

Harness compares synthesis against deterministic extracted state.

It performs deterministic repairs to a bounded fixed point and enforces a minimum verified quality floor.

Only thorough compaction may spend an additional LLM repair call before falling back to deterministic repair.

### 12.1 Structured output

Compaction should not produce only prose.

Its persistent representation should contain structured fields such as:

```text
goal
summary
decisions
constraints
working_set
completed
open_loops
errors
subagents
continuation
```

The synthesized narrative augments verified structured state rather than replacing it.

---

## 13. Persistence

Session history is persisted independently of live model context.

### Durable metadata

SQLite should store:

* sessions
* events
* agent relationships
* checkpoints
* artifact metadata
* tool metadata where appropriate

The session timeline should conceptually be append-only.

### Resume

A session can be reconstructed from:

```text
latest compaction checkpoint
+
events after checkpoint
```

Completed subagent transcripts persist independently and are referenced by handle.

---

## 14. Artifact Storage

Artifacts are divided by durability.

### Ephemeral

Safe to lose.

May use system temporary storage.

### Reconstructable cache

Stored under Harness cache storage and eligible for aggressive garbage collection.

### Session-critical

Persist until their owning session is deleted or expires.

### User-created output

Lives in the workspace and is never managed as disposable Harness storage.

Where practical, artifact storage should be content-addressed to avoid duplication.

Retention should be bounded through:

* reference tracking
* configurable size limits
* garbage collection
* LRU eviction for caches
* expiration of old disposable data

---

## 15. Repository Instructions

Harness follows the AGENTS.md convention rather than inventing a Harness-specific instruction file.

Instructions may exist at:

* repository root
* nested directories

Applicability is determined relative to files being operated on, allowing different parts of a monorepo to carry different instructions.

Harness runtime configuration remains separate from agent instructions.

---

## 16. Skills

Harness follows the Agent Skills format.

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

Harness supports Claude Code-style controls:

```yaml
user-invocable: true
disable-model-invocation: true
```

`disable-model-invocation: true` means the user may invoke the skill but agents may not autonomously activate it.

Explicit authorization may propagate to delegated subagents when appropriate.

Skills normally remain active for the current task rather than accumulating permanently across a session.

---

## 17. Agent Plugins

Harness supports Agent Plugins Specification packages as an interoperability format.

Agent Plugins are not Harness's architectural extension mechanism.

A package may contribute:

* Agent Skills
* MCP servers

These components feed the same internal registries used by built-in and locally configured capabilities.

Harness-specific subagent profiles remain outside the portable Agent Plugins v1 component model.

---

## 18. MCP

Agent Plugin-provided MCP configuration follows the Agent Plugins `mcp.json` format.

Global and project-local MCP configuration may live in Harness configuration while feeding the same internal MCP registry.

MCP servers should be lazy:

```text
configuration
     ↓
registered metadata
     ↓
search_tools
     ↓
call_tool
     ↓
start/connect MCP server if necessary
```

Idle MCP servers may be stopped later to reduce resource use.

Credentials and environment configuration must remain outside model context.

---

## 19. Configuration

Harness-specific configuration should remain separate from interoperability files.

Potential structure:

```text
~/.config/harness/
  config.toml
  skills/
  agents/

<repo>/
  AGENTS.md
  .harness/
    config.toml
    skills/
    agents/
```

Exact paths and precedence remain to be finalized.

---

## 20. Observability

Harness should expose enough information to understand its own resource usage and behavior.

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

## 21. Non-Goals

At least initially, Harness is not intended to provide:

* a public extension SDK
* a plugin marketplace
* generalized permission/approval workflows
* automatic model routing
* distributed execution infrastructure
* enterprise policy systems
* unlimited long-term semantic memory
* a novel coding interaction model purely for differentiation

---

## 22. Open Questions

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
