---
name: proactive-agent
description: Build proactive agents in Claude Code that act on their own schedule without being invoked. Use when setting up scheduled tasks, monitoring systems, heartbeat loops, or background agents that poll and alert. Triggers on: "CronCreate", "scheduled agent", "heartbeat monitor", "agent that runs automatically", "poll for changes without being asked", "cron in claude code", "background agent", "silent monitoring loop", "schedule a task", "proactive agent", "claude code cron", "autonomous schedule", "anticipatory agent", "agent state persistence", "save agent state", "save state before session ends". NOT for: external cron daemons (systemd/launchd/GitHub Actions), hooks-only setup (see persistent-memory skill #002), or one-time scripts.
---

# Proactive Agent

Reactive agents answer questions. Proactive agents anticipate needs.

Claude Code ships three native primitives for autonomous action — no external frameworks, no separate daemons:

| Mode | Primitive | When to Use |
|------|-----------|-------------|
| **Scheduled** | `CronCreate` | Fixed-interval jobs — daily digest, weekly retro, hourly PR scan |
| **Polled** | `/loop` + heartbeat | Continuous monitoring — silent unless something changed |
| **Hook-triggered** | `Stop` / `SessionStart` | State persistence, work queue drain on wake |

---

## Quick Entry

| I want to... | Go to |
|---|---|
| Schedule a task to run automatically | [01-cron-primitives.md](references/01-cron-primitives.md) |
| Build a monitor that polls silently | [02-heartbeat-pattern.md](references/02-heartbeat-pattern.md) |
| Save and restore state between sessions | [03-state-management.md](references/03-state-management.md) |
| See a complete PR/issue monitor | [04-end-to-end-monitor.md](references/04-end-to-end-monitor.md) |
| Understand what NOT to do | [05-anti-patterns.md](references/05-anti-patterns.md) |

---

## From Reactive to Proactive

The shift requires two things:
1. **A trigger** that fires without a user prompt (cron expression, poll interval, or hook)
2. **A silence contract** — output nothing on quiet checks, alert only when something changed

Without the silence contract, a polling agent becomes noise. The Paperclip CEO heartbeat is the canonical example: polls every 60 seconds, outputs nothing unless an issue changed status.

---

## CronCreate — Schedule a Task

```
CronCreate({
  name: "daily-digest",
  cron: "0 9 * * *",           // 9am every day
  prompt: "Check GitHub issues opened since yesterday. Post a digest.",
  workingDirectory: "/path/to/project"
})
```

Manage schedules:
- `CronList` — see all active crons
- `CronDelete({ name: "daily-digest" })` — cancel a schedule

Common expressions: `0 9 * * *` (9am daily), `0 */2 * * *` (every 2h), `0 9 * * 1` (Monday 9am).

→ Full reference with patterns: [01-cron-primitives.md](references/01-cron-primitives.md)

---

## Heartbeat Pattern — Poll Silently

```
/loop 60s Silently check [source] for [condition].
ONLY speak if [change detected]. If nothing changed, output NOTHING — completely silent.
```

The silence contract is non-negotiable. A heartbeat that narrates every quiet check burns context and creates noise. Output ONLY when the world changed.

→ Full reference: [02-heartbeat-pattern.md](references/02-heartbeat-pattern.md)

---

## State Management

Stop hook saves state before session ends. SessionStart hook restores it and drains the work queue.

```json
// ~/.claude/settings.json
{
  "hooks": {
    "Stop": [{
      "command": "node -e \"require('fs').writeFileSync('.claude/agent-state.json', JSON.stringify({lastCheck: Date.now(), queue: []}))\""
    }],
    "SessionStart": [{
      "command": "cat .claude/agent-state.json 2>/dev/null || echo '{\"lastCheck\":0,\"queue\":[]}'"
    }]
  }
}
```

→ Full reference with the `scheduled_tasks.lock` pattern: [03-state-management.md](references/03-state-management.md)

---

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "I'll add the silence contract later" | Without it, every quiet check generates output. It's one line. Add it now. |
| "I don't need state persistence for a simple cron" | Session ends, cron reschedules, reprocesses items it already handled. One state file prevents this. |
| "I'll just poll every minute, it's lightweight" | 1/min × 8h = 480 API calls. Use minimum interval for acceptable latency. |
| "Heartbeat can do everything CronCreate can" | Heartbeat needs an active session. CronCreate fires independently. Wrong tool = broken schedule when session closes. |
| "I'll check state from memory" | No memory between sessions without a file. No exceptions. Write the lock file. |

---

## End-to-End Example

PR + issue monitor: polls hourly, detects new items since last check, posts morning digest, silent otherwise.

→ [04-end-to-end-monitor.md](references/04-end-to-end-monitor.md)

---

## Anti-Patterns

→ [05-anti-patterns.md](references/05-anti-patterns.md)
