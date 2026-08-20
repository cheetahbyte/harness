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
harnez --resume
harnez --resume <session-id>
```

`harnez` starts the local server when needed and opens a new TUI session. Run
`harnez --resume` to choose from saved sessions, or add a session ID to resume
it directly.

```sh
harnez server start
harnez server status
harnez server stop
harnez server restart
harnez server run
```

`start`, `status`, `stop`, and `restart` manage the local server. `run` runs it
in the foreground.

## Releases

Create tags through the version-checked command:

```sh
bun run tag -- vx.y.z
```

Put the tag name first when passing additional `git tag` options.

The command refuses to tag unless the tag (with or without a `v` prefix)
matches `package.json`'s version. The pre-push hook also checks tags created
with plain `git tag` before allowing them to be pushed.

## Updating

```sh
harnez update
```

`harnez update` installs the latest release and restarts the local server so the
new build takes effect. The TUI also checks for new releases in the background
and reports one in the header; set `HARNEZ_DISABLE_UPDATE_CHECK=1` to opt out.
