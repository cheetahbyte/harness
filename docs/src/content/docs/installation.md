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

## From source

Harnez runs on [Bun](https://bun.sh). Clone the repository and install
dependencies:

```text
git clone https://github.com/cheetahbyte/harnez.git
cd harnez
bun install
```

Run the pieces directly during development:

```text
bun run dev     # server, restarts on change
bun run server  # server only
bun run tui     # terminal UI only
```

> [!TIP] Link the binary locally
> Run `bun link` from the repository root to make the `harnez` command
> available globally while you work on it.

## Verifying the install

```text
harnez --version
```

If this prints a version number, the binary is on your `PATH` and you're
ready to log in. See [Configuration](/docs/configuration) to set up a
provider.
