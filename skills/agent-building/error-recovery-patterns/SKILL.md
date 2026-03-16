---
name: error-recovery-patterns
description: Fault tolerance patterns for Claude Code agents. Installs checkpoint-before-risk (PreToolUse), circuit breaker (PostToolUse), and state serializer (Stop hook) so agents survive tool failures, crashes, and retry loops. Use when agents lose progress, fail silently, get stuck retrying, or need to resume after a crash. Triggers on: "agent fails silently", "lost all progress", "lose all my work", "I lost hours of work", "stuck in retry loop", "infinite retry", "agent keeps retrying", "agent crashed", "crash recovery", "graceful failure", "fault tolerance", "error recovery", "checkpoint pattern", "circuit breaker", "error budget", "resume after failure", "my agent died mid-task", "agent lost state", "no state saved on crash", "agent fails without warning", "agents fail in production". NOT for: MCP server errors (skill #006), root cause debugging (skill #013), external retry libraries (tenacity, langgraph).
---

# Error Recovery Patterns

Agents fail in three predictable ways. Each has a native hook that catches it:

| Failure Mode | Hook | Artifact |
|---|---|---|
| State loss on crash | Stop | recovery-manifest.md |
| Tool failures silently swallowed | PostToolUse | error-count.txt |
| Risky operation with no rollback | PreToolUse | recovery.md checkpoint |

Zero external dependencies. Three hooks, two files.

---

## Quick Setup

Three hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit|MultiEdit",
        "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/checkpoint.sh"}]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/circuit-breaker.sh"}]
      }
    ],
    "Stop": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/state-serializer.sh"}]
      }
    ]
  }
}
```

Full hook scripts: `references/checkpoint-pattern.md`, `references/circuit-breaker-hook.md`, `references/stop-hook-state.md`

---

## The Three Failure Modes

**State loss:** Agent crashes mid-task. No recovery manifest. Next session starts from scratch.

**Tool failure:** Tool call fails silently, agent continues on corrupt state. Errors compound without detection.

**Infinite retry:** Same failed call, same error, forever. Context fills with failure traces.

Each failure mode has a distinct detection signal and a distinct hook response.

→ Full taxonomy + signal detection: `references/failure-modes.md`

---

## Checkpoint Before Risky Operations

Before any destructive operation (file delete, git reset, database write), write a checkpoint to `recovery.md`. A PreToolUse hook auto-writes this before the call executes. If the session crashes, the next SessionStart hook reads `recovery.md` and resumes.

→ Full hook script + recovery.md template + SessionStart reader: `references/checkpoint-pattern.md`

---

## Circuit Breaker: PostToolUse Pattern

A PostToolUse hook tracks consecutive tool failures via `error-count.txt`. After threshold (default: 3), it exits 1 — blocking further agent action — and writes a human-escalation comment.

Three strikes: agent stops and asks for help instead of spiraling.

→ Full hook script + threshold config + error-count.txt format: `references/circuit-breaker-hook.md`

---

## Stop Hook: Serialize State on Exit

A Stop hook writes a recovery manifest on every session exit — normal or abnormal. The next session's SessionStart hook reads it and restores context.

Recovery manifest contents:
- Current task and sub-step
- Last checkpoint reached
- Files modified this session
- Last 5 errors
- One-sentence resume instruction

→ Full serializer + manifest format + SessionStart reader: `references/stop-hook-state.md`

---

## Sub-Agent Retry with Preserved Context

Never retry a failed operation in the same context. Accumulated error traces pollute reasoning. Delegate retry to a fresh sub-agent passing only the checkpoint manifest. Context rot is the primary reason inline retry loops fail.

→ Full pattern + checkpoint manifest schema: `references/sub-agent-retry.md`

---

## Human Escalation Protocol

**Rule:** Retry once with a different approach. If it fails again, write a blocked comment and stop.

Decision tree:
1. First failure → log error, retry with a different approach
2. Second failure → write blocked comment with full context, stop
3. Never: retry the same call with identical arguments

Silent failure that looks like success is the worst outcome. A blocked comment is a recoverable state.

→ Escalation comment template + when-to-give-up decision tree: `references/escalation-protocol.md`

---

## Resilient Agent Checklist

Before running any long autonomous task:

- [ ] PreToolUse checkpoint hook wired (recovery.md will be written before risky operations)
- [ ] Circuit breaker configured (threshold set, error-count.txt path defined)
- [ ] Stop hook wired (recovery manifest written on every exit)
- [ ] Escalation threshold set (default: 3 consecutive failures)
- [ ] Resume path documented (SessionStart hook reads recovery.md)
- [ ] Test: intentionally trigger a failure and verify the circuit breaker fires

→ Extended checklist + test-failure procedure + composition with #013 and #010: `references/resilient-agent-checklist.md`

---

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "My agent doesn't fail — this is overkill" | All long-running agents fail eventually. The question is whether you recover or restart. |
| "I'll add recovery hooks after I get it working" | You add them after the first catastrophic state-loss. That's too late. |
| "Retrying will eventually work" | Same call, same error, same result. Retry with a different approach or escalate. |
| "The error message is clear enough, I don't need a checkpoint" | The next session won't have that error message. The checkpoint will. |
| "Sub-agent retry is complex, I'll just retry inline" | Inline retry accumulates failure traces that corrupt reasoning. Sub-agent starts clean. |

---

## Reference Index

| File | Contents |
|---|---|
| `references/failure-modes.md` | Three failure mode taxonomy, hook-to-failure mapping, detection signals |
| `references/checkpoint-pattern.md` | PreToolUse hook script, recovery.md template, SessionStart reader |
| `references/circuit-breaker-hook.md` | PostToolUse hook script, error-count.txt format, threshold config |
| `references/stop-hook-state.md` | Stop hook serializer, recovery manifest format, SessionStart reader |
| `references/sub-agent-retry.md` | Sub-agent retry pattern, checkpoint manifest schema, context rot explanation |
| `references/escalation-protocol.md` | Decision tree, blocked comment template, when to give up |
| `references/resilient-agent-checklist.md` | Pre-flight checklist, test-failure procedure, integration with #013/#010 |
| `references/test-cases.md` | Trigger, no-trigger, and output test cases |
| `references/test-log.md` | Iteration history and scores |
