# Harness

The first vertical slice is a local Bun client/server agent harness. It owns one persistent session, streams events to a thin terminal client, and exposes the core `read`, `write`, `edit`, and `bash` tools without approval prompts.

```sh
bun install
bun run server
# separate terminal
bun run tui                 # starts a new session
bun run tui <session-id>    # resumes an existing session
```

The initial runtime accepts explicit commands while model/provider configuration is deliberately pending:

```text
/read path
/write path
file contents
/edit path
exact old text
---
replacement text
/bash
command
```

Enter sends a steering command (or starts work while idle). Option+Enter uses the common `Esc` + `Enter` terminal sequence to collect a follow-up; Esc aborts the current foreground operation. Terminal key encodings vary, so the follow-up key mapping is intentionally a small TUI implementation detail rather than a protocol feature.

## Milestone decisions

- Local IPC is HTTP on `127.0.0.1:7432`, with `POST /sessions`, `POST /sessions/:id/commands`, and an NDJSON event stream at `GET /sessions/:id/events`. This is the smallest reversible answer to the architecture's unspecified IPC protocol.
- `.harness/harness.sqlite` stores an append-only event timeline. Resume replays persisted events; there is no compaction checkpoint yet because full model transcripts/context construction are not in this slice.
- `packages/server/src/agent-runtime.ts` is the sole runtime seam. It imports Pi model/agent types behind a Harness-owned `AgentRuntime`, but provider authentication/model selection and a production Pi loop remain unimplemented because the architecture leaves their configuration and provider choices unresolved.
- The command adapter exists to prove the complete server → runtime → tools → event stream → persistence path without inventing a model-auth configuration. Core tools refuse paths outside the workspace; `bash` runs in the workspace and is cancellable.

## Scope review

Implemented: Bun workspace, local client/server split, one agent/session, core tools, streamed model/tool-shaped events, controls, and SQLite persistence/resume.

Deferred: provider configuration and actual Pi streaming loop, daemon lifecycle/reconnect, dynamic tools/MCP, subagents, context management/compaction, artifacts, diagnostics, and richer TUI navigation. The recommended next milestone is a configured OpenAI-compatible/Pi provider adapter that translates Pi agent events into the existing `ServerEvent` protocol and restores compact context from the event timeline.

```sh
bun test
bun run typecheck
```
