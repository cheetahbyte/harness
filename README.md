# Harness

The first vertical slice is a local Bun client/server agent harness. It owns one persistent session, streams events to a thin terminal client, and exposes the core `read`, `write`, `edit`, and `bash` tools without approval prompts.

```sh
bun install
bun run server
# separate terminal
bun run tui                 # starts a new session
bun run tui <session-id>    # resumes an existing session
```

Configure a model in the TUI before sending a task:

```text
/model openai-codex gpt-5.6-sol
/model openai-compatible my-model http://127.0.0.1:8080/v1
```

Codex subscription authentication is stored outside the session timeline:

```sh
bun run auth codex
```

For OpenAI-compatible endpoints, set `HARNESS_OPENAI_API_KEY` (or `OPENAI_API_KEY`); keyless local endpoints also work. The selected provider/model/base URL is persisted with the session, so `bun run tui <session-id>` continues with the same selection. Credentials are stored in `.harness/auth.json` with owner-only permissions and never enter model context or SQLite events.

The direct tool commands remain useful for testing the local boundary:

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
- `packages/server/src/agent-runtime.ts` is the sole Pi boundary. `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` share a matching version and stay behind Harness-owned runtime/provider interfaces.
- The existing event stream is preserved with two additive events: `assistant-reasoning-delta` when a provider exposes reasoning, and `usage` for available token metadata. Core tools refuse paths outside the workspace; `bash` runs in the workspace and is cancellable.

## Scope review

Implemented: Bun workspace, local client/server split, explicit persisted provider/model selection, Codex subscription login, OpenAI-compatible endpoints, Pi agent execution, core tools, streamed text/reasoning/tool/usage events, controls, and SQLite persistence/resume.

Deviation: a resumed session restores its configured provider/model but not historical model transcript context; the append-only event timeline does not yet retain a lossless Pi transcript. The next recommended milestone is durable context reconstruction/compaction from the session timeline, before adding dynamic tools or subagents.

Provider-specific limitation: Codex login needs an interactive browser flow (`bun run auth codex`). OpenAI-compatible endpoint compatibility varies by server; Harness uses Pi's OpenAI Completions adapter and exposes no automatic routing or provider-specific tuning surface yet.

```sh
bun test
bun run typecheck
```
