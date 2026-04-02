# Ruflo Claude Local Deployment Notes

This document describes the minimum path to test the `ruflo_claude_local` Paperclip adapter on a worker VM.

## Goal

Force engineering-class Paperclip workers to run Claude Code only when Ruflo is attached to Claude MCP.

## Provisioning Sequence

1. Install Node.js 20+ and `pnpm`.
2. Install Claude Code for the worker user.
3. Install Ruflo for that same worker user or make the `ruflo` binary available on `PATH`.
4. Log in to Claude Code for that same worker user.
5. Run:

```bash
./scripts/setup-ruflo-claude-local.sh
```

If you want Paperclip to use a dedicated Claude/Ruflo home directory for worker agents:

```bash
CLAUDE_CONFIG_HOME=/srv/paperclip/claude-home ./scripts/setup-ruflo-claude-local.sh
```

That script uses Claude MCP registration with user scope:

```bash
claude mcp add --scope user ruflo -- ruflo mcp start
```

unless the `ruflo` MCP server is already registered.

## Smoke Test

Before wiring the adapter into a live company, validate the worker environment:

```bash
./scripts/smoke-ruflo-claude-local.sh
```

Or against a dedicated worker home:

```bash
CLAUDE_CONFIG_HOME=/srv/paperclip/claude-home ./scripts/smoke-ruflo-claude-local.sh
```

This validates:

- Claude is installed
- Claude MCP registration contains `ruflo`
- Claude is logged in before attempting a live probe
- Claude can complete a simple headless probe once authenticated

## Paperclip Agent Config

In Paperclip, use adapter type:

- `ruflo_claude_local`

Recommended adapter config additions for managed workers:

```json
{
  "claudeConfigHome": "/srv/paperclip/claude-home",
  "rufloRequired": true,
  "rufloMcpServerName": "ruflo",
  "dangerouslySkipPermissions": true,
  "maxTurnsPerRun": 300
}
```

If you want direct binary verification in addition to Claude MCP verification:

```json
{
  "rufloCommand": "ruflo"
}
```

That is optional. The adapter primarily enforces Ruflo through Claude MCP presence.

## Recommended First Live Test

1. Create a new engineering agent using `ruflo_claude_local`.
2. Run Paperclip's adapter environment test for that agent.
3. Assign a tiny issue:
   - inspect a repo
   - write a one-file change
   - report result in the issue
4. Confirm the run succeeds.
5. Confirm the same agent fails if the Ruflo MCP entry is removed.

That last step proves the adapter is actually enforcing Ruflo rather than merely tolerating it.
