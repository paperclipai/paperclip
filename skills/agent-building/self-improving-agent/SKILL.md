---
name: self-improving-agent
description: Build Claude Code agents that improve themselves across sessions using native primitives. Use when your agent keeps repeating mistakes, rules aren't sticking, or you want a systematic feedback loop. Triggers on: "self-improving agent", "agent learning loop", "agent keeps making the same mistakes", "rule refinement", "violation detection hooks", "lessons learned file", "CLAUDE.md improvement", "iterative agent optimization", "keep discard loop", "agent feedback loop", "session memory improvement", "improve agent from mistakes", "agent self-improvement", "detect rule violations", "session audit hook", "capture agent learnings", "agent that learns", "make my agent better over time". NOT for: initial memory setup (use persistent-memory #002), harness architecture (use autonomous-agent #001), scheduled runs (use proactive-agent #009), or external memory frameworks (Mem0, vector DBs).
---

# Self-Improving Agent

Four native phases: **Detect** (violation hooks) → **Capture** (lessons file) → **Apply** (rule refinement) → **Verify** (keep/discard loop). No external tools.

The loop runs *across* sessions, not within them. Each session produces data. The loop consumes it.

---

## Quick Entry

| I want to... | Go to |
|---|---|
| Understand why agents repeat the same mistakes | [Why Agents Stay Dumb](#why-agents-stay-dumb) |
| See the improvement loop at a glance | [The Four-Phase Loop](#the-four-phase-loop) |
| Detect when my agent breaks its own rules | [01-violation-hooks.md](references/01-violation-hooks.md) |
| Build a structured lessons-learned.md | [02-lessons-file.md](references/02-lessons-file.md) |
| Update CLAUDE.md from real violation data | [03-rule-refinement.md](references/03-rule-refinement.md) |
| Run a keep/discard loop with objective scoring | [04-keep-discard-loop.md](references/04-keep-discard-loop.md) |
| Wire a Stop hook for session-end audit | [05-session-end-summary.md](references/05-session-end-summary.md) |
| Understand what NOT to do | [06-anti-patterns.md](references/06-anti-patterns.md) |

---

## Why Agents Stay Dumb {#why-agents-stay-dumb}

Every session starts cold. No memory of what broke last time. **Session amnesia** means an agent that captures nothing = an agent that repeats everything.

| Failure Mode | What happens |
|---|---|
| Capture without apply | Violations logged, CLAUDE.md never updated — same mistakes next session |
| Apply without verify | Rule changed without testing — scores drop silently |
| Verify without iterate | Loop runs once — improvement never compounds |

**The fix:** make all four phases mandatory. Skipping any one resets the loop to zero.

---

## The Four-Phase Loop {#the-four-phase-loop}

```
[1 DETECT] ──→ [2 CAPTURE] ──→ [3 APPLY] ──→ [4 VERIFY]
PostToolUse     lessons.md      CLAUDE.md     keep/discard
hook fires      append entry    rewrite rule      ↺ 8x
```

Runs *across* sessions. Each session produces violation data. The loop consumes it before the next session starts.

---

## Phase 1 — Detect: Violation Hooks

PostToolUse hook watches every tool call and classifies violations against `CLAUDE.md` rules.

→ Hook config, violation types, signal/noise routing: [01-violation-hooks.md](references/01-violation-hooks.md)

---

## Phase 2 — Capture: The Lessons File

Threshold: **2+ occurrences** before creating an entry. One session = noise. Two = pattern.

→ Entry format, dedup logic, pruning schedule: [02-lessons-file.md](references/02-lessons-file.md)

---

## Phase 3 — Apply: Rule Refinement

Group by violation type → find top 3 → diagnose why the rule failed → rewrite for specificity.

**The rule test:** read it cold. Do you immediately know what to do? If ambiguous → the rule fails, regardless of how long it's been in `CLAUDE.md`.

→ Diagnosis patterns, before/after examples, update workflow: [03-rule-refinement.md](references/03-rule-refinement.md)

---

## Phase 4 — Verify: Keep/Discard Loop

Run the same test cases before and after every change. Score on two dimensions:

| Metric | Keep if... |
|---|---|
| Trigger test pass rate | ≥80% (no regression from baseline) |
| Output test pass rate | No regression from baseline |
| Line count | Prefer fewer at equal score |

→ 8-iteration protocol, objective scoring, stop conditions: [04-keep-discard-loop.md](references/04-keep-discard-loop.md)

---

## Session-End Summary

Stop hook audits the session: violations fired, counts by type, 5-line summary saved to disk.

→ Hook config, output format, SessionStart pair: [05-session-end-summary.md](references/05-session-end-summary.md)

---

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "I'll update CLAUDE.md when I see the pattern" | By session 5, session 1 is gone. The hook fires automatically. Wire it now. |
| "This violation only happened once, not a pattern" | Correct — threshold is 2. But you won't remember session 1 happened unless you log it. |
| "My rules are clear, the agent just needs to follow them" | If it was clear, it wouldn't keep breaking. The lesson lives in the violation data, not your intuition. |
| "The keep/discard loop is overkill for a simple change" | One bad rule update cascades across all future sessions. One verification pass costs 10 minutes. |
| "I'll capture everything so I don't miss signal" | Noise beats signal when the lessons file is unreadable. Enforce the 2-occurrence threshold. |

---

## References

- [01-violation-hooks.md](references/01-violation-hooks.md) — PostToolUse hook, violation types, classification, signal vs noise
- [02-lessons-file.md](references/02-lessons-file.md) — lessons-learned.md structure, entry format, dedup, pruning
- [03-rule-refinement.md](references/03-rule-refinement.md) — CLAUDE.md update workflow, diagnosis patterns, rule test
- [04-keep-discard-loop.md](references/04-keep-discard-loop.md) — 8-iteration protocol, scoring criteria, stop conditions
- [05-session-end-summary.md](references/05-session-end-summary.md) — Stop hook, session audit, 5-line compression format
- [06-anti-patterns.md](references/06-anti-patterns.md) — Over-capturing, n=1 trap, complexity chasing, pruning neglect
