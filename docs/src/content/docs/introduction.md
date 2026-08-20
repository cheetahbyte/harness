---
title: Introduction
slug: introduction
---

# Introduction

Harnez is a small harness for coding agents. It runs the agent loop in a
server process and provides a terminal UI for interacting with it.

Harnez is model agnostic. You can connect any provider supported by the
underlying agent core. It does not include a dashboard, plugin marketplace, or
configuration that you did not request.

```text
bun packages/server/src/index.ts
```

## Why a harness instead of a framework

Harnez focuses on terminal-first coding agents. It is not a general extension
platform. It has no plugin marketplace or public SDK. The code is modular
internally, but the project does not provide a public extension API.

> [!TIP] Where to go next
> Start with [Installation](/docs/installation) to get the binary running,
> then read [Architecture](/docs/architecture) to see how the pieces fit
> together.

## Design principles

- **Coding first, not coding only.** Software development has the strongest
  user experience and tooling, but the runtime does not require it. You can
  also use Harnez for research, document analysis, and other agent workflows.
- **Model agnostic.** Models are runtime dependencies, not architectural
  foundations. Agents in the same session can use different models.
- **Trusted execution.** Harnez does not require approval prompts for ordinary
  reads, writes, edits, or shell commands. You control the session through
  visibility, steering, and interruption.
- **Context is scarce, but execution state is not.** Harnez stores large tool
  output outside the model's context window.
