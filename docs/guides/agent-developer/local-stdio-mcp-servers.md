# Local stdio MCP servers

Paperclip passes two kinds of MCP server to an agent run:

1. **Paperclip-managed connections** — HTTP, minted per run with a scoped bearer
   token. Nothing to configure here; they come from the company's connections.
2. **Locally-configured stdio servers** — anything the host operator runs as a
   local process (`mem0`, `browsermcp`, a homegrown tool server).

This page covers the second kind.

## Why a Paperclip-level file

The ACPX engine launches the vendored CLI in headless/SDK mode. That mode does
**not** read the user-scope MCP registry (`~/.claude.json`), so a server you
added interactively with `claude mcp add` is invisible to every Paperclip run.

Writing a project-scope `.mcp.json` into each agent's working directory does
work, but it is per-workspace: the file dies when a workspace is recreated, and
a newly-created workspace starts with no MCP servers at all. Configuration that
must apply to every run therefore lives outside every workspace:

```
<paperclip-instance-root>/mcp-servers.json
```

which by default is `~/.paperclip/instances/<instance-id>/mcp-servers.json`.

## Format

The file uses the familiar `.mcp.json` shape:

```json
{
  "mcpServers": {
    "mem0": {
      "type": "stdio",
      "command": "/opt/mem0-mcp-server/run.sh",
      "args": [],
      "env": {}
    }
  }
}
```

- `type` is optional and defaults to `stdio`. `http`/`sse` entries are skipped —
  remote connections belong to Paperclip's managed connection system, which
  mints per-run credentials for them.
- `disabled: true` keeps an entry in the file without launching it.
- `command`, `args`, and `env` values expand `${VAR}` and `$VAR` against the
  environment Paperclip builds for the run, so per-agent values such as
  `MEM0_USER_ID` or `PAPERCLIP_AGENT_ID` resolve without repeating them per
  entry. An undefined variable is left as written rather than silently emptied.
- A bare `{ "<name>": { ... } }` map (no `mcpServers` wrapper) is also accepted.

## Precedence

Later layers win on a name collision:

1. `<instance-root>/mcp-servers.json`
2. `PAPERCLIP_MCP_SERVERS_FILE` — an explicit path override, mainly for tests
   and one-off runs. Unlike the instance file, a missing path here is reported.
3. the agent's adapter config `mcpServers` value, for per-agent additions.

A Paperclip-managed connection always wins over a local entry of the same name;
the local entry is dropped and the run logs a warning.

## Verifying

Local stdio servers only apply to **local** execution. A run targeting a remote
or sandboxed execution environment skips them (the configured commands are host
paths that do not exist there) and logs how many were skipped.

Each run logs the servers it passed:

```
[paperclip] Passing 1 locally-configured stdio MCP server(s) to the agent: mem0
(from /Users/me/.paperclip/instances/default/mcp-servers.json).
```

To confirm the agent actually received them, read the `system` stream event with
`subtype == "init"` and check its `mcp_servers` array. Do not verify by looking
for the server process — a server can be spawned and still fail to register.

Malformed entries never abort a run: they are skipped with a warning on stderr.
A warning is logged on every lane, including a remote run that applies nothing.

Each local server joins the session identity as `{name, command, args, envHash}`,
so editing the config — including an `env` value — invalidates a warm handle and
the next run starts a session that has the change. Env values are hashed rather
than stored, because session parameters are persisted.
