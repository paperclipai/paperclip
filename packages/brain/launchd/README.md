# Brain launchd Services

Two macOS launchd services that run the Brain indexer and the MCP server in the background.

## Prerequisites

- Homebrew Postgres on `localhost:5432` with `pgvector` extension and a database named `paperclip_brain` (created during `pnpm migrate`).
- LM Studio running on `localhost:1234` with `text-embedding-bge-m3` loaded.
- Brain package built: `pnpm --filter @paperclipai/brain build`.

## One-time setup

```bash
# 1. Logs directory
mkdir -p ~/.whitestag-logs

# 2. Generate two bearer tokens (one per client)
openssl rand -hex 32   # → paste into BRAIN_PAPERCLIP_TOKEN slot
openssl rand -hex 32   # → paste into BRAIN_CLAUDE_CODE_TOKEN slot

# 3. Edit packages/brain/launchd/com.whitestag.brain-mcp.plist
#    Replace REPLACE_WITH_PAPERCLIP_TOKEN and REPLACE_WITH_CLAUDE_CODE_TOKEN
#    with the two random hex strings above.
#
#    The Paperclip plugin worker will need the same value in BRAIN_PAPERCLIP_TOKEN
#    via the plugin config UI / instance settings.
#
#    BRAIN_PAPERCLIP_ALLOWED_AGENTS is the comma-separated list of agentIds the
#    Paperclip token may claim in tool calls (e.g. CEO,CFO,CMO,CTO,CPO,walter).
#    The other two tokens (Claude Code, n8n) are locked to a single identity
#    and cannot claim other agentIds.
```

## Install services

```bash
cp packages/brain/launchd/com.whitestag.brain-indexer.plist ~/Library/LaunchAgents/
cp packages/brain/launchd/com.whitestag.brain-mcp.plist ~/Library/LaunchAgents/

launchctl load -w ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist
launchctl load -w ~/Library/LaunchAgents/com.whitestag.brain-mcp.plist
```

## Verify

```bash
launchctl list | grep whitestag.brain
tail -f ~/.whitestag-logs/brain-indexer.log
tail -f ~/.whitestag-logs/brain-mcp.log

# Should respond 401 (unauthorized) since no bearer token is sent — proves
# the service is up and the auth path is wired:
curl -i http://localhost:7777 -X POST -H 'content-type: application/json' -d '{}'
```

## Stop / unload

```bash
launchctl unload ~/Library/LaunchAgents/com.whitestag.brain-indexer.plist
launchctl unload ~/Library/LaunchAgents/com.whitestag.brain-mcp.plist
```

## Operational notes

- The plists assume the working tree at `~/Library/CloudStorage/SynologyDrive-Mac/Claude Code/Paperclip`. Adjust both `ProgramArguments` and `WorkingDirectory` if you ever relocate the repo.
- `KeepAlive.SuccessfulExit=false` means launchd will respawn the process on crash but not on a clean exit. `ThrottleInterval=30` prevents tight crash-loops.
- The first indexer run after a fresh DB performs a full vault scan (~22.000 markdown files × bge-m3 embedding). Expect ~1 hour of wall time and steady GPU usage from LM Studio.
