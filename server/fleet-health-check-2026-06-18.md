# Fleet Health Check — 2026-06-18 22:45 UTC

**Issue:** GRA-3518  
**Agent:** sentry-watcher (ad478672)  
**Brain:** 3b49e9c6

---

## Daemon Health

| Metric | Value |
|--------|-------|
| Status | ok |
| SDK Version | 0.7.5 |
| Brain Dir | /home/olive/.gradata/brain |
| Uptime | ~44 min (restarted recently) |
| Active Sessions | 0 |
| Rules Count | 2 |
| Lessons Count | 3 |

## Rules in Brain

```
# AGENTS.md
## FACTUAL
- Use 2026-06-18 instead of 2026-06-10
## STRUCTURE
- List or heading structure changed
```

## Apply-Rules Smoke Test

POST /apply-rules {"agent":"claude-code","text":"test"} → 2 rules fired:
- STRUCTURE:5357ad2b
- FACTUAL:a6c9a2ea

**Daemon verdict: HEALTHY. Rules serving correctly.**

---

## CLI Injection Status

| CLI | Mechanism | Status | Details |
|-----|-----------|--------|---------|
| **Claude Code** | CLAUDE.md | ❌ MISSING | No CLAUDE.md in ~/.claude/ |
| **Claude Code** | hooks/ dir | ❌ MISSING | No hooks/ directory |
| **Claude Code** | settings.json hooks | ⚠️ PARTIAL | 4 PostToolUse hooks configured (generated_runner_post, agent_graduation, tool_failure_emit, tool_finding_capture) pointing to /tmp/gradata-hn-test/venv. NO inject_brain_rules hook. |
| **Codex** | ~/.codex/ | ❌ MISSING | Directory does not exist |
| **Codex** | gradata plugin | ❌ MISSING | No plugin installed |
| **Gemini** | GEMINI.md | ❌ MISSING | No GEMINI.md in ~/.gemini/ |
| **OpenCode** | ~/.config/opencode/ | ⚠️ EMPTY | Directory exists but contains no files |
| **OpenCode** | AGENTS.md | ❌ MISSING | No AGENTS.md in opencode config |

---

## Summary

| CLI | Injection Working? |
|-----|-------------------|
| Claude Code | ❌ NO — hooks exist but no brain-rules injection (no CLAUDE.md, no inject_brain_rules hook) |
| Codex | ❌ NO — entire ~/.codex/ missing |
| Gemini | ❌ NO — GEMINI.md missing |
| OpenCode | ❌ NO — config dir empty |

**Overall verdict: 0 of 4 CLIs are injecting brain rules.**

The daemon is healthy and serving rules correctly via the API, but none of the 4 target CLIs have the filesystem injection files (CLAUDE.md, GEMINI.md, AGENTS.md) or plugin mechanisms in place.

## Root Cause

The previous comment (June 18 00:05 UTC) claimed all 4 CLIs were passing, but the actual filesystem state shows:
- CLAUDE.md was never created in ~/.claude/
- ~/.codex/ was never initialized
- GEMINI.md was never created
- ~/.config/opencode/ exists but is empty (AGENTS.md never written)

The daemon's `.last_injection.json` shows 2 anchors (a6c9, 5357) but these are only served via the API — no filesystem sync mechanism is writing them to the CLI config directories.

## Recommended Actions

1. **Create CLAUDE.md** in ~/.claude/ with brain rules content
2. **Add inject_brain_rules hook** to Claude Code settings.json
3. **Initialize ~/.codex/** and install gradata plugin
4. **Create GEMINI.md** in ~/.gemini/
5. **Create AGENTS.md** in ~/.config/opencode/
6. **Implement filesystem sync** in gradata-plugin to auto-write these files on rule changes
