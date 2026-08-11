---
title: Architecture
---

# Architecture

Harnez uses a local client/server architecture. Running `harnez` connects to
an existing server or starts one — from the outside it should still feel
like one application.

```text
┌──────────────────────┐
│      TUI Client      │
└──────────┬───────────┘
           │
       local IPC
           │
┌──────────▼───────────┐
│    Harnez Server     │
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
└──────────────────────┘
```

## Runtime

The server is a long-lived process implemented in TypeScript on Bun. The TUI
stays thin — expensive session and agent state lives on the server, not the
client, so the interface can be killed and reattached without losing work.

## Agent loop

A turn is a straight line: a user message goes through context construction
into a model call; tool calls come back, run, and their results feed back
into context for the next model call. It ends when the model responds
without requesting further action.

```text
User message → context → model call → tool calls
  → tool execution → tool results → context → model call → … → response
```

Three inputs steer that loop from the TUI:

- **Enter** modifies the active task in place — the model restarts around
  the new message.
- **Option + Enter** queues a follow-up task for after the current one
  finishes, without altering it.
- **Esc** aborts the current foreground step: generation, running tools, and
  anything pending in that step.

## Subagents

Subagents are isolated agents with predefined profiles (`implementer`,
`explorer`, `reviewer`, and similar). A subagent doesn't inherit the parent's
whole transcript — it starts from its profile, relevant skills, applicable
repository instructions, and an explicit task brief. It reports back a
compact result: status, changes, verification performed, and anything
unresolved. The parent never imports a child's raw transcript.

## Context management

Harnez separates the lossless session history from the bounded working set
sent to a model. Every context item is tracked as `pinned`, `active`,
`retained`, or `archived`; system instructions, user messages, and explicit
pins are protected from being dropped. Tool output is externalized at
creation — the model sees a bounded preview and a reference it can use to
recall the exact result later.

When the context budget is crossed, one deterministic cleanup pass runs:
completed tool exchanges retire first, then completed work archives in a
fixed order, oldest first. Nothing is silently rewritten or deleted; the full
event history persists independently of what's currently in the model's
context.

## Progressive tool discovery

The permanent tool surface is small — file reads/writes/edits, shell,
subagent controls, and user interaction. Everything else (MCP tools, Agent
Plugin tools) lives in a searchable capability registry: `search_tools`
returns compact metadata, `call_tool` executes a specific one by ID. The
model never sees a full catalog of every configured tool on every turn.
