---
name: self-improvement
description: >
  Self-review and improvement of
  agent behavior and code.
---

# Self Improvement Skill

Run a structured self-improvement cycle: reflect on recent agent behavior,
identify concrete improvement targets, apply changes, verify them, and iterate.
This skill models the same disciplined loop Hermes Agent uses for its own
continuous improvement.

**This is a self-review and improvement pass, not a bug hunt.** You are
improving the agent's own behavior and code quality — removing duplication,
flattening needless complexity, cutting waste, deepening band-aid fixes, and
strengthening verification. Do not go hunting for correctness bugs here;
that's what `requesting-code-review` is for.

**Core principle:** One reflection pass, then one improvement pass, then one
verification pass — each with checkable completion criteria. No drift, no
marketing fluff, no unbounded scope.

## When to Use

Trigger this skill when the user says any of:

- "improve yourself" / "self-improve" / "self improvement"
- "review your own work" / "reflect on your behavior"
- "get better at X" / "improve your X"
- "/self-improvement" (if they carry the habit over)

Optional modifiers:

- **Focus:** "self-improvement focus on efficiency" → narrow to the efficiency angle only.
- **Scope:** "self-improvement on the last session" / "self-improvement on
  tools/AGENTS.md" → narrow the review surface accordingly.
- **Dry run:** "self-improvement but don't change anything" → run reflection,
  present findings, apply nothing. Ask before applying.

Do NOT auto-run after every turn. It costs subagent tokens and user attention
— invoke it only when explicitly requested.

## Prerequisites

- Hermes agent core loaded (`run_agent.py`, `agent/`, `model_tools.py`)
- `delegate_task` available for parallel reflection (if disabled, run inline)
- Access to `terminal`, `read_file`, `write_file`, `patch`, `search_files`
  toolsets

## How to Run

```text
self-improvement [--focus <angle>] [--scope <surface>] [--dry-run]
```

Run through the `terminal` tool or as a direct skill invocation. The skill
self-orchestrates through its three phases.

## Quick Reference

| Step | Action | Tool |
|------|--------|------|
| Reflect | Review recent behavior, code, and decisions | `delegate_task` + `search_files` + `read_file` |
| Identify | List concrete improvement targets with criteria | `search_files` + `read_file` |
| Apply | Make targeted changes | `write_file` + `patch` |
| Verify | Run tests/lints on touched files | `terminal` |
| Iterate | Repeat if verification fails or gaps remain | Re-run skill |

## Procedure

### Phase 1 — Reflect (self-review)

1. **Capture the review surface.** Gather recent session artifacts:
   - `AGENTS.md` (root and area-level)
   - `agent/` turn-loop files
   - `tools/` implementations
   - `hermes_cli/` CLI modules
   - Recent conversation history / memory conclusions

   Use `search_files` to surface recently-modified files, then `read_file`
   to read them. Completion criterion: every file in the review surface has
   been read at least once.

2. **Launch reflection reviewers.** Use `delegate_task` batch mode with
   two reviewers running concurrently:

   **Reviewer A — Behavior Reflection**
   > Review recent agent turns for: repetition loops, ignored user
   > instructions, premature conclusions, unverified assumptions, tool misuse,
   > and missed opportunities to ask clarifying questions. For each finding,
   > cite the turn or file and suggest a concrete behavior change.

   **Reviewer B — Code Reflection**
   > Review recent code changes for: duplication, unnecessary complexity,
   > dead code, missing tests, weak error handling, and violations of
   > `AGENTS.md` conventions (no defensive clutter, no `try/except: pass`,
   > comments keep the WHY not the WHAT). For each finding, cite `file:line`
   > and suggest a concrete fix.

   Give each reviewer the complete surface context, not fragments.

3. **Aggregate findings.** Merge both reviewers' output, dedupe overlaps,
   discard false positives, resolve conflicts (correctness > user focus >
   readability > micro-perf).

### Phase 2 — Identify (concrete targets)

From the aggregated findings, produce a prioritized target list:

| # | Target | File:Line | Fix | Risk | Done? |

Each target must have:
- A checkable completion criterion ("the duplicate helper at X is removed and
  callers use Y instead")
- A risk tier: SAFE / CAREFUL / RISKY
- An owner decision: apply now / flag for review / skip

Completion criterion: every finding from Phase 1 is either a target row or
explicitly skipped with a reason.

### Phase 3 — Apply (targeted changes)

Apply targets in risk-tier order:

1. **SAFE first** (auto-apply): unused imports, commented-out code, dead
   branches, redundant type assertions. Run tests after.
2. **CAREFUL next** (apply with verification, one file at a time): rename
   locals, flatten ternaries, extract helpers, consolidate duplicates. Run
   tests after each file. Revert any that break.
3. **RISKY last** (flag for review — do NOT auto-apply): public API changes,
   concurrency fixes, error-handling changes, architectural shifts. Present
   each with risk description; let the user decide.

If the user opted for dry run, present all targets and apply nothing.

### Phase 4 — Verify

1. Run targeted tests for touched files (not the full suite).
2. Re-run any linter/type check the repo uses (`scripts/check` or equivalent).
3. If a fix breaks a test, revert that one fix and report it.
4. Re-read `AGENTS.md` to confirm no convention was violated.

Completion criterion: all applied targets pass their verification checks, or
each failure is documented with a revert.

### Phase 5 — Iterate

If verification surfaced new gaps, or if the user wants another round, re-run
the skill from Phase 1 with the updated scope. Stop when:
- All targets are applied and verified, or
- The user says stop, or
- No further improvement targets remain.

## Pitfalls

- **Don't drift into bug-hunting.** Correctness bugs go to `requesting-code-review`,
  not here. Report them prominently as separate "found a bug" notes.
- **Apply ≠ rewrite.** Keep edits scoped to what the review surface touched
  plus minimal surrounding changes. Don't unilaterally rebuild shared
  infrastructure inside a self-improvement pass.
- **Don't fan out wider than 2 reviewers.** More reviewers means more cost and
  more conflicting suggestions, not better coverage.
- **Respect `AGENTS.md` conventions.** If the repo has rules, fold them into
  the reviewer prompts so suggestions match house style.
- **Large surfaces blow context.** If the review surface is huge, scope it
  down before delegating.
- **No unbounded iteration.** Each round must produce measurable improvement
  or stop. Don't loop forever on marginal gains.

## Related

- `simplify-code` — parallel four-reviewer cleanup of recent code changes
- `requesting-code-review` — pre-commit security/quality gate (bug hunt)
- `systematic-debugging` — diagnosis loop for hard bugs
- `test-driven-development` — test-first feature and bug work

## Verification Checklist

- [ ] Review surface captured and every file read
- [ ] Two reflection reviewers ran (behavior + code)
- [ ] Target list produced with file:line, fix, risk tier, and done status
- [ ] SAFE targets auto-applied; CAREFUL targets applied with verification
- [ ] RISKY targets flagged for user review, not auto-applied
- [ ] Targeted tests and linters pass on all touched files
- [ ] No `AGENTS.md` convention violated
- [ ] Iteration stopped when no further targets remain
