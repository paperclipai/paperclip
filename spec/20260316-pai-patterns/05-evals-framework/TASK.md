# Step 5: Evals Framework

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this task.

## Quick Reference
- **Branch:** `feat/pai-patterns-05-evals`
- **Complexity:** M
- **Dependencies:** None
- **Estimated files:** 5-7

## Objective
Build a lightweight eval runner that programmatically tests skills using their existing test-cases.md files, scores results with a judge prompt, and tracks historical results for version comparison. Expose as a `/eval` slash command.

## Context from Research
PAI has evals as a utility workflow (Packs/Utilities/src/Evals/SKILL.md). Our system already has the inputs: every skill ships with `references/test-cases.md` containing trigger tests, no-fire tests, and output quality tests. The QC agent runs these manually. What's missing is an automated runner with scoring and history.

**Current eval flow (manual):**
1. QC agent reads test-cases.md
2. Runs each test case by simulating the trigger
3. Eyeballs results
4. Posts pass/fail to Paperclip issue comment

**Target eval flow (automated):**
1. `bun run scripts/eval-runner.ts skills/agent-building/autonomous-agent/SKILL.md`
2. Runner reads test-cases.md, executes each test
3. Judge prompt scores each result
4. Results saved as JSON with timestamp
5. `/eval` slash command wraps the runner for interactive use

**Key constraint:** Eval runner can't actually invoke Claude Code skills (that requires a running REPL). Instead, it evaluates:
- **Trigger accuracy:** Given a prompt, does the skill description match? (string similarity + judge)
- **Output quality:** Given the skill content and a scenario, does the output meet the test case assertions? (judge prompt)

## Prerequisites
- [ ] At least one skill with a well-formed test-cases.md to test against

## Implementation

**Read these files first** (in parallel):
- `skills/agent-building/autonomous-agent/references/test-cases.md` — Example test cases format
- `skills/agent-building/code-review-automation/references/test-cases.md` — Another test case example
- `skills/agent-building/highimpact-skill-builder/references/test.md` — Test methodology reference

### 1. Understand Test Case Format

Read 2-3 test-cases.md files to understand the current format. They typically contain:
- **Trigger tests:** "User says X → skill should fire"
- **No-fire tests:** "User says Y → skill should NOT fire"
- **Output tests:** "Given scenario Z → output should contain/demonstrate A, B, C"

### 2. Build the Eval Runner

Create `scripts/eval-runner.ts`:

```typescript
#!/usr/bin/env bun

/**
 * Skill eval runner. Tests trigger accuracy and output quality.
 *
 * Usage:
 *   bun run scripts/eval-runner.ts <skill-path>
 *   bun run scripts/eval-runner.ts skills/agent-building/autonomous-agent/SKILL.md
 *   bun run scripts/eval-runner.ts --all              # Run all skills
 *   bun run scripts/eval-runner.ts --compare <skill>  # Compare latest vs previous
 */
```

**Core flow:**
1. Parse SKILL.md to extract name, description (trigger signal)
2. Parse test-cases.md to extract test cases (trigger, no-fire, output)
3. For trigger tests: score description match against test prompt
   - Use Levenshtein distance + keyword overlap as a fast heuristic
   - For borderline cases, invoke the judge prompt
4. For output tests: concatenate SKILL.md + relevant references, simulate the scenario, judge output quality
5. Aggregate scores: trigger %, no-fire %, output %
6. Save results to `skills/evals/results/{skill-name}/{YYYY-MM-DD}.json`

**Results JSON format:**
```json
{
  "skill": "autonomous-agent",
  "date": "2026-03-16",
  "version": "1.0.0",
  "scores": {
    "trigger": { "pass": 12, "fail": 0, "total": 12, "pct": 100 },
    "noFire": { "pass": 5, "fail": 0, "total": 5, "pct": 100 },
    "output": { "pass": 10, "fail": 0, "total": 10, "pct": 100 }
  },
  "overall": 100,
  "failures": [],
  "duration_ms": 4523
}
```

### 3. Create Judge Prompt

Create `skills/evals/judges/skill-quality.md`:

The judge evaluates:
- **Trigger match:** "Given this user prompt and this skill description, would Claude Code's skill matcher fire this skill? Answer YES/NO with confidence 0-100."
- **Output quality:** "Given this skill's content and this test scenario, rate the output on: completeness (0-10), accuracy (0-10), actionability (0-10). Explain any deductions."

The judge prompt should be specific enough to produce consistent scores across runs. Include rubric criteria for each score level.

### 4. Historical Comparison

The `--compare` flag reads the two most recent result files for a skill and produces a diff:

```
autonomous-agent: v1.0.0 (2026-03-15) → v1.0.1 (2026-03-16)
  Trigger:  100% → 100% (=)
  No-fire:  80%  → 100% (+20%)
  Output:   90%  → 95%  (+5%)
  Overall:  90%  → 98%  (+8%)

  Fixed: "no-fire: MCP server setup" now correctly excluded
  Regression: none
```

### 5. Create /eval Skill

Create `skills/eval/SKILL.md`:

```markdown
---
name: eval
description: Run skill evaluations. Triggers on: "/eval", "evaluate skill", "test skill quality", "benchmark skill", "run evals". NOT for: writing test cases (use highimpact-skill-builder), QC review (use QC agent).
---

# Skill Evaluation

Run `bun run scripts/eval-runner.ts <skill-path>` with the appropriate arguments.

## Modes
- `/eval skills/agent-building/[name]/SKILL.md` — Evaluate one skill
- `/eval --all` — Evaluate all skills
- `/eval --compare [name]` — Compare latest vs previous for one skill
```

## Files to Create/Modify

### Create:
- `scripts/eval-runner.ts` — Eval orchestrator
- `skills/evals/judges/skill-quality.md` — Judge prompt and rubric
- `skills/evals/results/.gitkeep` — Results directory
- `skills/eval/SKILL.md` — /eval slash command skill

### Modify:
- None (this is additive)

## Verification

### Automated Checks
```bash
# Verify eval runner exists and has correct shebang
head -1 scripts/eval-runner.ts

# Run eval on one skill
bun run scripts/eval-runner.ts skills/agent-building/autonomous-agent/SKILL.md

# Verify results saved
ls skills/evals/results/autonomous-agent/

# Verify judge prompt exists
test -f skills/evals/judges/skill-quality.md && echo "PASS" || echo "FAIL"
```

### Manual Verification
- [ ] Eval runner produces valid JSON results
- [ ] Scores are reasonable (known-good skills score 80%+)
- [ ] Judge prompt produces consistent scores across multiple runs
- [ ] `--compare` output is readable and useful
- [ ] `/eval` skill triggers correctly

## Success Criteria
- [ ] eval-runner.ts runs and produces JSON results for any skill with test-cases.md
- [ ] Judge prompt scores trigger, no-fire, and output quality
- [ ] Results saved with timestamps for historical tracking
- [ ] `--compare` shows delta between versions
- [ ] `/eval` slash command works

## Scope Boundaries
**Do:** Build the runner, judge prompt, results tracking, and slash command
**Don't:** Build model comparison (same eval on Opus vs Sonnet). Don't build cross-skill regression suites. Don't build a results dashboard UI. Don't modify existing test-cases.md files.

## Escape Route Closure
- "We should use Claude API directly for judging" → Only if we can't get good results from the skill evaluation pattern. Start with the simplest approach — read SKILL.md, simulate scenario, judge output.
- "We need a web dashboard for results" → JSON files + `--compare` CLI is the dashboard. If we need more, build it later.
- "Test cases need a standardized format first" → No. The runner adapts to what exists. Standardizing is a separate task that blocks nothing.
