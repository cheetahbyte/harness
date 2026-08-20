---
title: MCP servers
slug: advanced/mcp
---

# MCP servers

Harnez connects to Model Context Protocol servers and adds their tools to the
capability catalog with its built-in tools. Configuration uses the
[Agent Plugins](https://agent-plugins.org/) `mcp.json` format, so the same file
works in other clients that read it.

> Review a server before connecting it. Its tools run with the authority of the
> task that calls them, and their names and descriptions are written by the
> server.

## Locations

Harnez reads two files:

| Scope | Location |
| --- | --- |
| User | `~/.config/harnez/mcp.json` |
| Project | `<repo>/.harnez/mcp.json` |

Both are optional. When both define a server under the same name, the project
file wins. The project file is the one belonging to the session's workspace, not
to whatever directory the Harnez server happens to have been started from.

MCP configuration sits in its own file instead of `settings.json` because the
format is defined by the specification, not by Harnez.

## Configure a server

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "validator": {
      "type": "stdio",
      "command": "./bin/validator",
      "args": ["--data", "${PLUGIN_DATA}/validator"],
      "env": { "CONFIG": "${PLUGIN_ROOT}/config.json" },
      "cwd": "${PLUGIN_ROOT}"
    },
    "deployment-api": {
      "type": "streamable-http",
      "url": "https://deploy.example.com/mcp",
      "headers": { "X-Tenant": "public-tenant" }
    }
  }
}
```

`$schema` and `mcpServers` are both required, and no other top-level field is
allowed. Harnez matches `$schema` against the exact identifier above to pick its
validation rules. It never fetches the URL.

Restart the server with `harnez server restart` after editing the file. Each
workspace scans its configuration once, when its first session opens, so an
edit is not picked up by starting another task. `/mcp` switches a configured
server on or off without a restart.

## Transports

| `type` | Support |
| --- | --- |
| `stdio` | Local process, launched by Harnez. |
| `streamable-http` | Remote endpoint over HTTP. |
| `sse` | Parsed but skipped, with a warning. The legacy transport is optional in the specification. |

### `stdio`

| Field | Required | Behavior |
| --- | --- | --- |
| `command` | Yes | One executable token: a bare name resolved on `PATH`, or a path beginning with `./` resolved against the config directory. |
| `args` | No | Arguments passed to the executable. |
| `env` | No | Environment entries layered over the inherited environment. |
| `cwd` | No | Working directory. Defaults to the config directory. |

`command` is never a shell string. Write `"command": "node"` with
`"args": ["server.js"]`, not `"command": "node server.js"`, which Harnez
rejects. A `./` path may not escape the directory holding `mcp.json`, including
by symlink.

### `streamable-http`

| Field | Required | Behavior |
| --- | --- | --- |
| `url` | Yes | Absolute HTTP or HTTPS endpoint, with no user information and no fragment. |
| `headers` | No | Fixed headers sent when connecting. |

Plain `http://` works only for `localhost` and loopback addresses. Everything
else must use HTTPS. Harnez treats two header names that differ only in case as
a duplicate and rejects the entry.

## Variables

Two variables are available to `stdio` servers, both as placeholders in the
configuration and as environment variables in the launched process:

| Variable | Value |
| --- | --- |
| `PLUGIN_ROOT` | The directory holding the `mcp.json` that declared the server. |
| `PLUGIN_DATA` | `~/.config/harnez/mcp-data/<server>`, created before launch. |

Use `PLUGIN_ROOT` for files shipped alongside the config, and `PLUGIN_DATA` for
state a server needs to keep, such as caches or installed dependencies.

Expansion applies to `args`, the values in `env`, and `cwd`. It does not apply
to `env` keys, `command`, `url`, or headers. Substitution happens once, so text
introduced by a replacement is not expanded again, and anything that only looks
like a placeholder, such as `${HOME}`, stays literal.

Harnez sets both variables itself, after applying your `env`. A configuration
that declares `PLUGIN_ROOT` or `PLUGIN_DATA` under `env` is invalid.

## Credentials

`mcp.json` is configuration you can commit, not a secret store. Keep tokens out
of `env` and `headers`.

Stdio servers inherit the environment Harnez runs in, so export the secret in
your shell and read it in the server:

```sh
export GITHUB_TOKEN=...
harnez
```

## Discovery and loading

Tools enter the capability catalog as metadata only, so connecting a server that
exposes hundreds of tools does not put hundreds of schemas in every request. The
model loads one when it needs it:

```text
mcp.json → connect → catalog entry → capabilities_search
         → capabilities_inspect → tools_load → call
```

Tools are named `mcp__<server>__<tool>`, so two servers can expose the same tool
name without colliding. A tool that declares itself read-only in its MCP
annotations becomes a read-only capability. Anything else counts as mutating.

Harnez connects to a workspace's servers when a session in it opens, rather than
on first use, because a task's catalog is built from the tool metadata each
server reports.

## Servers belong to a workspace

The Harnez server is one daemon shared by every project on the machine, but
`mcp.json` is resolved per workspace. A session opened in one project sees that
project's `.harnez/mcp.json` and your user file. It never loads another
project's configuration or binaries. This also controls where a relative
`command` resolves.

Two projects that configure the same server share one child process. Harnez
matches the server's transport, command, arguments, environment, and roots, not
the configured name. The same server named `gh` in one project and `github` in
another still uses one process. Its `PLUGIN_DATA` directory comes from the
configured name, so deliberately separate installations stay separate.

## Idle servers

A connection nobody has used for fifteen minutes is closed, and its tools stay
in the catalog. The next call to one of them starts the server again, paying the
handshake once. Nothing about this is visible to the model: an idle server has
exactly the same capabilities as a running one, and `/mcp` marks it `idle`.

## Switching servers on and off

`/mcp` lists every server configured for the current workspace, from both the
user and project files. It shows each server's source and tool count:

```text
MCP Servers · 2/3 connected

  [x] duckduckgo · global · stdio · 2 tools
  [x] github · project · streamable-http · 4 tools · idle
  [ ] spokenly · project · stdio · off
```

`Space` switches a server on or off, `Enter` saves, and `Esc` closes the menu.
Typing filters the list. Saving takes effect immediately. Harnez releases a
server that you switch off and stops its child unless another workspace still
has it on. Harnez connects a server that you switch on before the menu redraws,
including the reason if the connection fails. An off server contributes nothing
to the catalog.

The tool count is what a server costs during discovery: entries the model pages
through when it searches. It is not a per-turn cost. MCP tools stay out of every
request until `tools_load` admits one, and only that tool's schema joins the
list, for the rest of that task.

The choice is stored in `settings.json` as
[`disabledMcpServers`](/docs/configuration), so it survives a restart. Because
the list records exclusions, a server added to `mcp.json` later starts out
connected.

A task already running keeps the tools it started with; the change applies to
the next task, which builds a fresh catalog.

## When something fails

A problem with one server never affects the others, and none of these stop a
session:

| Problem | Result |
| --- | --- |
| Invalid JSON, wrong `$schema`, or an unknown top-level field | That file is ignored. The other file still loads. |
| Invalid server entry | That server is skipped. The other servers still load. |
| Unsupported transport | That server is skipped. |
| Server will not start or connect | That server is skipped, reported in the log, and shown with its error in `/mcp`. |

Each case is logged with the file, the server name, and the reason.

## Troubleshooting

If a server's tools do not appear:

1. Check that `$schema` is exactly the 1.0.0 identifier shown above.
2. Check that the file has only `$schema` and `mcpServers` at the top level, and
   that each server has only the fields its transport defines.
3. Confirm `command` is a single token, and that a `./` path exists and is
   executable.
4. Run the server manually with the same command, arguments, and working
   directory to confirm it speaks MCP over stdio.
5. Check the server logs for the reason. Harnez logs every file and entry it
   skips.
6. Confirm the server is in `/mcp` and switched on. A server missing from that
   list was never resolved; one shown as off was switched off.
7. Restart the server with `harnez server restart`. Configuration is read once
   per workspace, when its first session opens.

If the tools appear in `capabilities_search` but the model does not use them,
that is expected until it calls `tools_load`. See
[Tool discovery](/docs/architecture/tool-discovery) for how the catalog works
and [Configuration](/docs/configuration) for other configuration files.
