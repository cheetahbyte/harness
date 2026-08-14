---
title: MCP servers
slug: advanced/mcp
---

# MCP servers

Harnez connects to Model Context Protocol servers and adds their tools to the
same capability catalog as its built-in tools. Configuration uses the
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
file wins.

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

Start a new task after editing the file. Running tasks keep the capability
snapshot they started with.

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

Harnez connects to servers when it starts rather than on first use, because a
task's catalog is built from the tool metadata each server reports.

## When something fails

A problem with one server never affects the others, and none of these stop a
session:

| Problem | Result |
| --- | --- |
| Invalid JSON, wrong `$schema`, or an unknown top-level field | That file is ignored. The other file still loads. |
| Invalid server entry | That server is skipped. The other servers still load. |
| Unsupported transport | That server is skipped. |
| Server will not start or connect | That server is skipped and reported. |

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
6. Start a new task. Configuration is read when a task starts.

If the tools appear in `capabilities_search` but the model does not use them,
that is expected until it calls `tools_load`. See
[Tool discovery](/docs/architecture/tool-discovery) for how the catalog works
and [Configuration](/docs/configuration) for other configuration files.
