---
title: Introduction
---

# Introduction

Harnez is a minimal harness for coding agents. It ships a server process that
runs the agent loop, and a terminal UI to drive it. That's the whole surface
area.

It is model-agnostic — plug in any provider through the underlying agent core
— and stays out of your way otherwise: no dashboard, no plugin marketplace, no
config you didn't ask for.

```text
bun packages/server/src/index.ts
```

## Why a harness, not a framework

Harnez is opinionated about one workflow — terminal-first coding agents — and
doesn't try to be a general extension platform. There's no plugin
marketplace and no public SDK. Good internal modularity is a goal; public
extensibility isn't.

> [!TIP] Where to go next
> Start with [Installation](/docs/installation) to get the binary running,
> then read [Architecture](/docs/architecture) to see how the pieces fit
> together.

## Design principles

- **Coding-first, not coding-bound.** Software development gets the strongest
  UX and tooling, but the runtime doesn't assume it — research, document
  analysis, and other agentic workflows work too.
- **Model-agnostic.** Models are runtime dependencies, not architectural
  foundations. Different agents in the same session can use different
  models.
- **Trusted execution.** Harnez doesn't gate ordinary reads, writes, edits,
  or shell commands behind approval prompts. Control comes from visibility,
  steering, and interruption instead.
- **Context is scarce; execution state is not.** Large tool output is
  externalized rather than stuffed into the model's context window.
