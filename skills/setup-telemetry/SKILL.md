---
name: setup-telemetry
description: Configure Claude Code telemetry hooks. Two setup paths — lightweight Langfuse cloud (quick start) or self-hosted custom dashboard + FastAPI backend (full observability, no cloud).
license: MIT
compatibility: claude-code
metadata:
  audience: developers
  domain: observability, telemetry, claude-hooks
roles: [cto, developer]
---

# Skill: Setup Telemetry

Configure Claude Code to emit telemetry events from its lifecycle hooks.

**Trigger when:** Setting up observability for Claude Code sessions, tracking tool usage, monitoring session activity, or deploying the custom telemetry dashboard.

---

## Two Setup Paths

### Path A — Langfuse (Cloud, quick start)

Streams events to [Langfuse](https://langfuse.com) cloud. Free tier available, zero infra.

**Steps:**
1. Create a Langfuse project at https://cloud.langfuse.com
2. Copy Public Key and Secret Key
3. Write `~/.claude/LANGFUSE_CONFIG.env`:
   ```
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_HOST=https://cloud.langfuse.com
   ```
4. Verify the hooks in `~/.claude/settings.json` reference the telemetry hook scripts (see Hook Integration section below)

### Path B — Custom Dashboard (Self-hosted, full control)

Runs a local FastAPI backend on `:5001` and a Next.js dashboard on `:3001`. All data stays local (SQLite). Provides live feed, session timeline, tool inspector, and metrics panels.

**Stack:**
- **Backend:** `backend/` — FastAPI + SQLAlchemy + SQLite, exposes `/events`, `/sessions`, `/metrics`, `/live`, WebSocket at `/ws/sessions/{id}`
- **Dashboard:** `dashboard/` — Next.js 14, Tailwind CSS, Recharts, SWR for live polling

**One-command setup:**
```bash
python3 ~/.claude/skills/setup-telemetry/scripts/setup_custom_dashboard.py
```

This script:
1. Copies `backend/` and `dashboard/` to `~/.paperclip/instances/` (configurable via `--dest`)
2. Runs `pip install -r requirements.txt` in backend
3. Runs `npm install` in dashboard
4. Starts backend on `:5001` (daemonized, logs to `backend.log`)
5. Starts dashboard on `:3001` (daemonized, logs to `dashboard.log`)
6. Updates all `~/.claude/hooks/*.py` to POST to `http://localhost:5001/events`

**Custom destination:**
```bash
python3 ~/.claude/skills/setup-telemetry/scripts/setup_custom_dashboard.py --dest ~/my/instances
```

**After setup:**
- Dashboard: http://localhost:3001
- Backend health: http://localhost:5001/health
- Logs: `{dest}/telemetry-backend/backend.log`, `{dest}/telemetry-dashboard/dashboard.log`

**Stop services:**
```bash
kill $(cat ~/.paperclip/instances/telemetry-backend/.backend.pid)
kill $(cat ~/.paperclip/instances/telemetry-dashboard/.dashboard.pid)
```

---

## Hook Integration

The telemetry hooks live in `~/.claude/hooks/` and are registered in `~/.claude/settings.json`:

| Hook file | Event | What it sends |
|-----------|-------|---------------|
| `session_start_telemetry.py` | `SessionStart` | session ID, cwd, project name |
| `pre_tool_use_telemetry.py` | `PreToolUse` | tool name, tool input |
| `post_tool_use_telemetry.py` | `PostToolUse` | tool name, output, duration, errors |
| `session_end_telemetry.py` | `SessionEnd` | duration, session summary |

All hooks POST to `http://localhost:5001/events` (Path B) or use `langfuse_client` (Path A). They fail silently to avoid blocking Claude Code tool execution.

**Event schema** (POST `/events`):
```json
{
  "session_id": "claude-code-abc123",
  "event_type": "PreToolUse | PostToolUse | SessionStart | SessionEnd",
  "tool_name": "Bash",
  "tool_input": {},
  "tool_output": {},
  "duration_ms": 142.5,
  "error_message": null,
  "metadata": {}
}
```

---

## Bundled Source

This skill ships with the full source for both services:

```
setup-telemetry/
  backend/           FastAPI backend (app.py, database.py, models.py, requirements.txt)
  dashboard/         Next.js frontend (app/, components/, lib/)
  scripts/
    setup_custom_dashboard.py   Deployment + startup script
  SKILL.md
```

The bundled source is a snapshot. To update it from the running instances:
```bash
rsync -av --exclude='node_modules/' --exclude='.next/' \
  ~/.paperclip/instances/telemetry-dashboard/ \
  ~/.claude/skills/setup-telemetry/dashboard/

rsync -av --exclude='__pycache__/' --exclude='*.db' \
  ~/.paperclip/instances/telemetry-backend/ \
  ~/.claude/skills/setup-telemetry/backend/
```

---

## Key Design Decisions

- **SQLite for local storage** — zero config, file-per-instance, no server process needed for the DB layer
- **Hooks fail silently** — `except` blocks swallow all errors; a broken backend never blocks Claude tool execution
- **CORS wide open** — backend allows all origins for sandbox/local dev compatibility; tighten for shared deployments
- **WebSocket per session** — dashboard subscribes to `ws://localhost:5001/ws/sessions/{id}` for real-time updates without polling
- **Port convention** — backend `:5001`, dashboard `:3001` (avoids conflicts with common `:3000`/`:5000` dev servers)
