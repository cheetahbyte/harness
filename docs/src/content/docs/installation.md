---
title: Installation
slug: installation
---

# Installation

## From npm

```text
npm install -g harnez
```

This installs the `harnez` binary, which starts (or attaches to) the local
server and opens the TUI.

Bun is not required for an npm installation. Initial supported platforms are
macOS (Apple Silicon and Intel) and Linux x64.

## From source

Harnez runs on [Bun](https://bun.sh). Clone the repository and install
dependencies:

```text
git clone https://github.com/cheetahbyte/harnez.git
cd harnez
bun install
```

Use the CLI during development:

```text
bun run cli
```

See [CLI reference](/docs/cli-reference) for starting, stopping, and resuming
sessions. See [Configuration](/docs/configuration) to set up a provider.
