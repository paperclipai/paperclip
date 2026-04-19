---
title: Channel-Driven Agents
summary: How to run a persistent claude+ agent with live message push instead of spawn-per-heartbeat
---

Paperclip's default agent model spawns a fresh `claude --print` subprocess per heartbeat. For agents that need low-latency response — customer support chat, real-time monitoring, long-running context — you can instead run a **persistent `claude+` inside tmux** and use an MCP channel plugin to push work into the running session.

This is how SharpAPI runs its Nova (email/SEO), Sentinel (integrity), and Maya (customer support) agents.

## Architecture

```
Paperclip server
    │  POST /heartbeat  (assignment, @-mention, timer)
    ▼
Agent LXC :8201  ◄── paperclip-channel.ts (bun MCP plugin, child of claude+)
    │  MCP notification: notifications/claude/channel
    ▼
claude+ in tmux  ◄── long-running session, picks up and acts
    │
    ├─► paperclip_update MCP tool → issue comment / status
    └─► paperclip_checkout / etc.

Agent LXC :8200  ◄── paperclip-listener.py (standalone external liveness probe)
    │  GET /health
    ▼
  { tmux ✓, claude ✓, paperclip-channel ✓, jsonl_age: 12s }
```

Heartbeats go to `:8201` (channel MCP). `:8200` is a separate external-monitoring probe you can optionally cron against.

## Setup

### 1. systemd unit — `/etc/systemd/system/claude-channels.service`

```ini
[Unit]
Description=Claude Code Channels (<Agent name>)
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
User=root
WorkingDirectory=/<agent>-workspace
ExecStart=/usr/bin/tmux new-session -d -s claude-channels /usr/local/bin/claude-channels.sh
ExecStop=/usr/bin/tmux kill-session -t claude-channels
RemainAfterExit=yes
Restart=on-failure
RestartSec=30

[Install]
WantedBy=multi-user.target
```

### 2. Launch script — `/usr/local/bin/claude-channels.sh`

```bash
#!/bin/bash
export PATH="/root/.local/bin:/root/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export HOME="/root"
export IS_SANDBOX=1
export LANG="en_US.UTF-8"
export TERM="xterm-256color"

source /root/.claude/channels/telegram/.env 2>/dev/null
source /etc/default/paperclip 2>/dev/null

cd /<agent>-workspace

# Idempotent tmux guard — systemd restart won't duplicate sessions
if [ -z "$TMUX" ]; then
  if tmux has-session -t claude-channels 2>/dev/null; then
    echo "claude-channels session already exists; tmux kill-session -t claude-channels to force restart"
    exit 0
  fi
  exec tmux new-session -d -s claude-channels "$0"
fi

# Auto-dismiss dev-channels dialog if it appears
# (hasDevChannels is in-memory only in claude+, reappears on every start)
(
  for i in {1..30}; do
    sleep 1
    if tmux capture-pane -t claude-channels:0 -p 2>/dev/null | grep -q "Enter to confirm"; then
      tmux send-keys -t claude-channels:0 "1" C-m
      break
    fi
  done
) &

exec claude+ --channels \
  plugin:telegram@claude-plugins-official \
  --dangerously-load-development-channels \
  server:paperclip
  # add server:crisp server:approval etc. as needed
```

### 3. tmux config — `/root/.tmux.conf`

```
set -g allow-passthrough on
set -g default-terminal "tmux-256color"
set -ga terminal-overrides ",*256col*:Tc"
set-option -g window-size largest
set -g aggressive-resize on
set -g history-limit 50000
```

`window-size largest` is critical — without it tmux clamps the session to the smallest attached client, which ruins readability when you SSH in from a narrow pane.

### 4. Paperclip agent config

```bash
curl -X PATCH "$PAPERCLIP_API_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "adapterConfig": { "url": "http://<lxc-ip>:8201/heartbeat" },
    "runtimeConfig": { "heartbeat": { "enabled": true, "intervalSec": 300 } }
  }'
```

**The field is `intervalSec`, not `intervalSeconds`.** The wrong name saves silently but the scheduler reads `intervalSec` and nothing fires.

### 5. AGENTS.md — mention guidance

Channel-driven agents get woken on `issue_comment_mentioned` and `issue_reopened_via_comment` independently. If your agent is both the assignee AND someone @-mentions a different agent on the same issue, the assignee gets a wake too. Include this rule in AGENTS.md:

> **When you receive an @-mention directed at another agent** (you were woken as assignee or watcher): stay silent. Don't post a "this isn't for me" comment — the mentioned agent already has its own wake. Over-commenting creates noise.

### 6. External liveness probe (optional but recommended)

`/opt/paperclip-listener/listener.py` on port 8200 — a tiny Python HTTP server that checks:

- `tmux has-session -t claude-channels`
- `pgrep -f 'claude.*--channels'`
- `pgrep -f 'paperclip-channel.ts'`
- Most recent `~/.claude/projects/*/*.jsonl` mtime (hang detection, default 30min threshold)

Run it with `python3 -u` (unbuffered) under systemd so logs reach the journal.

## Gotchas

| Symptom | Cause | Fix |
|---------|-------|-----|
| Heartbeats succeed but @-mentions never reach claude+ | adapter URL pointed at `:8200` (Python listener) instead of `:8201` (channel MCP) | PATCH `adapterConfig.url` → `:8201` |
| Scheduled heartbeats never fire, `lastHeartbeatAt` frozen | Wrong field name `intervalSeconds` | Use `intervalSec` |
| Restart requires manual `1 Enter` keystroke | `--dangerously-load-development-channels` dialog re-prompts on every run, not persisted | Auto-dismiss sidecar in launch script |
| `●` `⎿` `✻` glyphs render as `_` | TERM=linux from systemd inherits minimal terminfo | `export TERM="xterm-256color"` + tmux `default-terminal` |
| Tmux pane clamped to narrow width after SSH reconnect | tmux default is smallest-client sizing | `set-option -g window-size largest` |
| Two claude+ processes, one zombie, `:8201` port collision | Service restarted without killing the old claude+'s children | Kill-all before restart: `pkill -9 -f "claude --channels\|paperclip-channel\|crisp-channel\|approval-channel"` then `systemctl restart` |
| Python listener comment spam ("HTTP POST http://...") | HTTP adapter's summary leaks as issue comment | Fixed upstream in `server/src/adapters/http/execute.ts` (`summary: null`) |

## Verifying a new agent

Once configured, a 3-step smoke test covers the full pipeline:

1. **Liveness**: `curl http://<lxc-ip>:8201/health` → `200 {"status":"ok","channel":true}`
2. **Direct assignment**: create an issue assigned to the agent, verify response within ~30s
3. **@-mention routing**: comment `@<AgentName> …` on an issue, verify wake + response

For the assignee/watcher silence rule, file an issue assigned to your new agent that asks *them* to @-mention another agent (e.g. `@Nova what date is today?`) and verify the two-hop round-trip completes cleanly without extra noise comments.
