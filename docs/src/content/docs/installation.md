---
title: Installation
slug: installation
---

# Installation

## From npm

```text
npm install -g harnez
```

This installs the `harnez` binary. The binary starts or attaches to the local
server and opens the TUI.

Bun is not required for an npm installation. Initial supported platforms are
macOS (Apple Silicon and Intel) and Linux x64.

## Updating

```text
harnez update
```

This command installs the latest release and restarts the local server. Harnez
also checks for new releases in the background and reports them in the TUI
header. See [Updating](/docs/cli-reference#updating) for details.

## From source

Harnez runs on [Bun](https://bun.sh). Clone the repository, then install the
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

See the [CLI reference](/docs/cli-reference) to start, stop, and resume
sessions. See [Configuration](/docs/configuration) to configure a provider.
