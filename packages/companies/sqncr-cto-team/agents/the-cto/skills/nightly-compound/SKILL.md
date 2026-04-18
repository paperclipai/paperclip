---
name: nightly-compound
description: Nightly compound review loop. Enables any agent to learn and improve from its own work through automated self-review cycles.
---

# Nightly Compound

Automated self-improvement loop for any agent. Reviews recent work, extracts lessons, updates memory, and prevents repeated mistakes.

## What This Skill Does

Every agent accumulates experience. Without a structured review loop, that experience evaporates between sessions. This skill provides the protocol for nightly self-review: what worked, what broke, what to remember.

## When It Runs

Set up as a nightly cron job (recommended: 2-4 AM in the user's timezone, Sonnet model for cost efficiency). Runs automatically, no user intervention needed.

## The Review Protocol

### Phase 1: ORIENT
Read workspace files (MEMORY.md, recent session history, any task logs). Understand current state before reviewing.

### Phase 2: EXTRACT
From recent work, identify:
- **Wins:** What produced good results? What patterns should be repeated?
- **Corrections:** Where did the user correct you? What assumption was wrong?
- **Friction:** Where did communication break down? What caused confusion?
- **Patterns:** What recurring situations need a documented approach?

### Phase 3: ENCODE
Update workspace files with extracted lessons:
- Add new entries to MEMORY.md with dates
- Update rules or beliefs that need strengthening
- Remove outdated information that no longer applies
- Add patterns that prevent repeated mistakes

### Phase 4: PRUNE
Keep memory files lean and actionable:
- Remove entries older than 30 days that haven't been referenced
- Consolidate similar lessons into single clear rules
- Archive resolved issues

### Phase 5: RESTRUCTURE
When MEMORY.md exceeds ~15K characters (~4K tokens), flat files get silently truncated by context limits. The agent loses the middle of its memory without knowing it. Restructure into an index + detail files:

1. **Detect:** If MEMORY.md > 15K characters, trigger restructure.
2. **Categorize:** Group entries by type (systems, patterns, issues, rules, daily logs, history).
3. **Create structure:**
   ```
   memory/
     systems/       # How things work
     patterns/      # Recurring approaches
     issues/        # Active problems
     rules/         # Hard constraints with propagation checklists
     history/       # Resolved items worth keeping
     YYYY-MM-DD.md  # Daily logs (archive after 7 days)
   ```
4. **Build index:** Replace MEMORY.md with a table of contents. Each entry: topic, status, file path, trigger keywords. Keep the index under 3K tokens.
5. **Move hard rules to the top of the index.** These must always be visible (never truncated).
6. **After restructure:** New entries go into detail files, not the index. Index only gets new rows pointing to new files.

The index pattern: "Drill down, don't guess. Loading a file is cheaper than a wrong assumption."

## Cron Setup

Add this to the agent's cron configuration:

```json
{
  "name": "nightly-compound-{agent-id}",
  "agentId": "{agent-id}",
  "schedule": {
    "kind": "cron",
    "expr": "0 2 * * *",
    "tz": "{user-timezone}"
  },
  "sessionTarget": "isolated",
  "payload": {
    "kind": "agentTurn",
    "model": "anthropic/claude-sonnet-4-6",
    "message": "{AGENT_NAME} COMPOUND REVIEW - Nightly improvement.\n\n1. Read your workspace files and recent work.\n2. What worked? What broke? What did the user correct?\n3. Update MEMORY.md with lessons that change behavior.\n4. Prune anything stale.\n\nMax 15 min. Only keep what matters.",
    "timeoutSeconds": 900
  },
  "delivery": {"mode": "none"},
  "enabled": true
}
```

## Stagger Timing

If multiple agents share a system, stagger compound loops 5-10 minutes apart to avoid resource contention:

| Agent | Suggested Time |
|-------|---------------|
| Agent 1 | 2:00 AM |
| Agent 2 | 2:10 AM |
| Agent 3 | 2:20 AM |
| Agent 4 | 2:30 AM |

## What Good Compound Learning Looks Like

After 30 days, an agent with compound engineering should:
- Have a MEMORY.md with 15-30 dated, actionable entries
- Catch mistakes it made in week 1 automatically by week 4
- Adapt its communication style to match user preferences it discovered
- Reference past decisions and their outcomes when facing similar situations
- MEMORY.md stays under 3K tokens as an index, with detail files for depth

## What Bad Compound Learning Looks Like

- MEMORY.md that grows to 200+ lines of vague observations
- Entries like "user prefers concise responses" repeated 12 times
- No pruning (memory becomes noise)
- Generic lessons that don't change behavior ("be more careful")
- MEMORY.md over 15K characters with no restructuring (middle gets silently truncated)
