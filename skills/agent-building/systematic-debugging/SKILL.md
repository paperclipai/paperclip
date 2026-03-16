---
name: systematic-debugging
description: Systematic debugging methodology for Claude Code. Installs three disciplines: pre-commit Stop hook (blocks broken commits), reproduce-first protocol (failing test before any fix), and hypothesis-driven debug loop (root cause tracing, not symptom chasing). Use when debugging AI-generated code, setting up pre-commit test gates, tracing root causes, or building a repeatable debug workflow. Triggers on: "debug workflow", "pre-commit test hook", "stop hook for tests", "root cause analysis", "reproduce the bug", "hypothesis-driven debugging", "broken commits", "debug session log", "regression test workflow", "systematic debugging", "test before commit", "claude code debugging", "debug session", "I keep debugging for hours", "spend hours debugging", "spending hours debugging", "55% debugging", "55% of my time debugging", "code breaks and I spend hours". NOT for: production monitoring (Sentry/Datadog), IDE debugger integration (DAP), distributed tracing.
---

# Systematic Debugging

Claude Code generates code fast. Debugging it eats back all the time you saved — because no methodology means every bug is a fresh hunt. This skill installs three disciplines:

1. **Pre-commit Stop hook** — blocks the session from ending until tests pass
2. **Reproduce-first protocol** — never touch an error without a failing test that pins it
3. **Hypothesis-driven loop** — ranked bets tested in order, root cause found first

All native Claude Code primitives. No external tools. Composes with TDD Workflow (#007) and Self-Improving Agent (#010).

---

## Quick Setup

Two hooks in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/debug-gate.sh"}]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{"type": "command", "command": "bash ~/.claude/hooks/debug-log.sh"}]
      }
    ]
  }
}
```

Full hook scripts → `references/pre-commit-stop-hook.md` and `references/debug-session-log.md`

---

## Why Debugging Eats 55% of Your Time

AI-generated code is harder to debug than hand-written code: it's opaque (no mental model of why it was written that way), overengineered (fixes surface issues by adding complexity), and not written to be traced (no intermediate state, long chains).

The result: "just paste the error and ask Claude to fix it" creates fix-break-fix loops. Without a pinned reproducer, Claude is guessing. Without a hypothesis, it's trying random changes. Without root cause tracing, the same bug resurfaces.

Three disciplines eliminate each failure mode.

---

## The Pre-Commit Stop Hook

A Stop hook runs your test suite before every Claude session exits. Exit 1 = session blocked. Claude sees the test output and must fix before it can finish.

**Auto-detect test runner (from project root):**

| Project file | Runner |
|---|---|
| `package.json` + bun lockfile | `bun test` |
| `package.json` | `npm test` |
| `pyproject.toml` or `pytest.ini` | `pytest` |
| `Cargo.toml` | `cargo test` |

The hook detects which runner to use automatically.

→ Complete hook script with detection logic: `references/pre-commit-stop-hook.md`

---

## Reproduce First

**Rule:** Never attempt a fix without a failing test that reproduces the issue.

Steps:
1. Get the error message and stack trace
2. Ask Claude: *"Write a minimal test that triggers this exact error"*
3. Confirm the test fails — reproducer is valid
4. Only then begin fixing

**Why it works:** The bug lives in state, timing, or environment. Without a pinned reproducer, the fix is a guess. With one, the fix is measurable — the test goes from red to green.

**Anti-pattern:** "I understand the bug, I don't need a test." That's confidence without evidence. The test proves understanding.

---

## The Hypothesis Loop

Form 3 hypotheses ranked by likelihood. Test each in order. Cross off eliminated paths.

```
H1 (most likely): [hypothesis] — TEST: [what to check]
H2: [hypothesis] — TEST: [what to check]
H3: [hypothesis] — TEST: [what to check]
```

Prevents shotgun debugging: random changes, endless retries, Claude confidently "fixing" symptoms.

→ Full procedure + Agent tool delegation patterns: `references/hypothesis-loop.md`

---

## Root Cause vs. Symptom

Surface errors (`undefined`, `NullPointerException`, `500`) almost never describe the actual problem. Apply the 5 Whys — ask "why" five times to trace from symptom to root cause. Fix the root cause. Everything else is symptom treatment.

→ Error chain tracing patterns + 5 Whys templates: `references/root-cause-tracing.md`

---

## Debug Session Log

A PostToolUse hook on Bash writes each debugging attempt to `debug-log.md` in your project root. Never repeat a dead end. Feed the self-improving loop.

**Log format:**
```
[2026-03-16 14:23] H1 DISPROVED: checked state at line 42, X is populated
[2026-03-16 14:31] H2 CONFIRMED: input validation returns false on empty string
[2026-03-16 14:35] Root cause: empty string not handled in validateInput()
[2026-03-16 14:40] Fix applied: added guard + regression test added
```

→ Full hook script + log maintenance: `references/debug-session-log.md`

---

## Regression Prevention

Every bug fix ships with a test that would have caught the bug. This compounds: the pre-commit gate grows more protective with each fix.

| Bug type | Test pattern |
|---|---|
| Logic error | Unit test on the function with the failing case |
| Edge case | Parameterized test with the edge input |
| API contract | Integration test pinning expected response |

**Rule:** If your fix doesn't include a regression test, the bug isn't fixed — it's temporarily absent.

→ Regression test templates by failure type: `references/regression-prevention.md`

---

## The Full Loop

**Pre-commit catches it → reproduce → hypothesize → root cause → fix → regression test → commit passes**

Typical bug: < 30 minutes. The Stop hook doesn't let you leave until it does.

→ End-to-end real debugging session walkthrough: `references/full-workflow-walkthrough.md`

---

## Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "I'll just paste the error and ask Claude to fix it" | That's symptom-chasing. Without a hypothesis, every fix is a guess. Guesses compound. |
| "I understand the bug, I don't need a reproducer" | You think you understand it. The failing test proves you do. Skip it and find out the hard way. |
| "The Stop hook will slow me down" | It blocks you for 30 seconds when tests fail. The alternative is debugging broken commits for 30 minutes. |
| "I found the problem, no need to trace root cause" | You found a symptom. The root cause is why the symptom exists. Skip it and the bug comes back. |
| "I'll skip the regression test this time" | That bug is the one you debug again in three weeks without a test protecting it. |

---

## Reference Index

| File | Contents |
|---|---|
| `references/pre-commit-stop-hook.md` | Stop hook script, multi-runner detection, git pre-commit alternative |
| `references/hypothesis-loop.md` | Full loop procedure, Agent tool prompts, loop templates |
| `references/root-cause-tracing.md` | 5 Whys for code, error chain tracing, state inspection |
| `references/debug-session-log.md` | PostToolUse hook script, log format, integration with #010 |
| `references/regression-prevention.md` | Regression test templates by failure type |
| `references/full-workflow-walkthrough.md` | Real end-to-end debugging session (< 30 min) |
| `references/test-cases.md` | Trigger, no-trigger, and output test cases |
| `references/test-log.md` | Iteration history and scores |
