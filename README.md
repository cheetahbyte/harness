# Harnez

Minimal harness for agentic coding and more.

## Install

```sh
npm install -g harnez
```

Bun is not required to install or run Harnez from npm. Initial supported
platforms are macOS (Apple Silicon and Intel) and Linux x64.

## Usage

```sh
harnez
harnez --resume <session-id>
```

`harnez` starts the local server when needed and opens a new TUI session.
Use `--resume` to open an existing session.

```sh
harnez server start
harnez server status
harnez server stop
harnez server run
```

`start`, `status`, and `stop` manage the local server. `run` runs it in the
foreground.
