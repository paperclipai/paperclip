---
name: highimpact-skill-builder
description: Use when creating, testing, improving, or benchmarking Claude Code skills. Triggers on: "create a skill", "make a skill for X", "turn this into a skill", "improve this skill", "test this skill", "benchmark this skill", "optimize skill description", "skill performance", "skill quality", "write a skill that does X", "skill triggering", "skill isn't working well", "quick skill". Skills are the highest-leverage artifact in Claude Code — one good skill multiplies across every future invocation. This skill guides the full lifecycle.
---

# High-Impact Skill Builder

**Three phases:** Create → Test → Improve. Description optimization is a finishing step after the skill works.

---

## Phase Detection

Before acting, locate where the user is:

| Signal | Phase |
|--------|-------|
| "Create a skill for X" / "Turn this into a skill" / No existing SKILL.md | Phase 1: Create |
| Existing SKILL.md + "test it" / "does it work" / no test results yet | Phase 2: Test |
| Test results exist + "improve" / "it missed" / "make it better" / quality gap | Phase 3: Improve |
| Skill works well + "description" / "not triggering" / "optimize" | Description Optimization |
| "Quick" / simple skill / user just wants draft-and-test once | Quick Mode |

**If ambiguous:** Ask one question — "Do you have an existing SKILL.md to work with, or are we starting fresh?"

---

## Phase 1: Create

**Goal:** Capture intent precisely, then write a SKILL.md that does exactly that — no more.

1. **Interview the user** (2-4 questions max):
   - What task should this skill handle? Be specific.
   - What's the trigger context? (user phrase, workflow stage, file type)
   - What does success look like?
   - Any gotchas or non-obvious requirements?

2. **Write SKILL.md** to `skills/[skill-name]/SKILL.md`:
   - Frontmatter: `name`, `description` (triggering-optimized — see "Skill Writing Guide" below)
   - Body: phase detection if the skill has multiple modes, then reference files for details
   - Keep under 200 lines — use `references/` for depth

3. **Stage test cases immediately** — don't wait. Draft 3-5 prompts that should trigger this skill and 2-3 that should NOT. Save to `references/test-cases.md`.

See `references/create.md` for: interview question bank, SKILL.md templates, naming conventions, common anti-patterns.

---

## Phase 2: Test

**Goal:** Verify the skill triggers reliably and produces correct output.

1. **Run trigger tests** — feed the "should trigger" prompts to Claude Code. Observe whether the skill fires.

2. **Run output tests** — for each test case that triggers, evaluate the output against drafted assertions.

3. **Show results inline** — a simple pass/fail table. No server needed.

4. **Flag gaps** — any missed triggers, wrong triggers (false positives), or output quality issues.

5. **Save checkpoint** — write current iteration number and test scores to `references/test-log.md` before proceeding. This survives context compression.

See `references/test.md` for: assertion patterns, trigger-testing procedure, output evaluation rubric, how to handle borderline cases.

---

## Phase 3: Improve

**Goal:** Close the gap between current behavior and target behavior. Iterate until score meets threshold (default: 80% pass rate on trigger + output tests combined).

**Each iteration:**
1. Identify the root cause of each failure (wrong description? missing pattern? unclear instructions?)
2. Edit SKILL.md — one focused change per iteration, not a rewrite
3. Re-run affected test cases
4. Update `references/test-log.md` with new scores
5. Checkpoint: save what changed and why

**Common fixes by failure type:**

| Failure | Likely Cause | Fix |
|---------|-------------|-----|
| Skill doesn't trigger | Description too narrow | Add more trigger phrases; broaden synonyms |
| False positive triggers | Description too broad | Add "NOT for:" exclusions |
| Output misses key step | Instruction ambiguous | Rewrite that section; add example |
| Skill too long, skipped | Body too dense | Move detail to `references/`, leave pointers |
| Inconsistent behavior | No phase detection | Add explicit routing logic |

**Stop condition:** 3 iterations with no improvement → escalate to description optimization or accept current state and document the gap.

See `references/improve.md` for: root cause analysis patterns, iteration discipline, when to rewrite vs. patch, regression prevention.

---

## Quick Mode

**Trigger:** "quick skill", "just draft it", or clearly one-shot with no ambiguity.

1. Capture intent in one exchange (no interview)
2. Write SKILL.md
3. Run 3 trigger tests manually
4. Ship — document gaps in `## Known Limitations`

Skips: benchmarking, assertion drafting, test-log checkpointing. Faster delivery, less reliability assurance.

---

## Description Optimization

**When:** Skill works but isn't triggering consistently, or fires on wrong prompts.

The description is the routing signal. Claude Code matches user intent against it. Weak descriptions = missed triggers or false positives.

**Checklist:**
- [ ] Includes the exact phrases users naturally say ("turn this into a skill", "make a skill for X")
- [ ] Includes synonyms for the core action (create/write/build/draft)
- [ ] Includes the workflow context (when in their process this fires)
- [ ] Excludes adjacent concepts that should NOT trigger it (add "NOT for: X" phrasing if needed)
- [ ] Under 3 sentences — longer descriptions get truncated in matching

**Pattern — high-trigger description:**
```
Use when [doing action] or [adjacent action]. Triggers on: "[phrase 1]", "[phrase 2]", "[phrase 3]".
Also fires for: [workflow stage], [user role context]. NOT for: [clear exclusion].
```

See `references/optimize.md` for: description A/B testing procedure, trigger phrase bank, false-positive debugging.

---

## Skill Writing Guide

### Writing Style

- **Imperative:** "Run the test. Record the score." Not "You should run the test."
- **Explain the why once.** Then drop it. Repetition wastes context.
- **Tables over prose** for comparisons, mappings, checklists.
- **Code blocks** for any command the user will copy.
- **Progressive disclosure:** high-level in SKILL.md, depth in `references/`.
- **No fluff.** "This section covers X" → just cover X.

### What Makes a Skill High-Impact

1. **Precise trigger description** — fires when intended, not otherwise
2. **Clear phase detection** — user always knows where they are
3. **Opinionated defaults** — don't make users make decisions the skill should make
4. **Escape hatches** — document how to override defaults
5. **Checkpoint discipline** — saves state so loops survive compression
6. **Reference structure** — keeps main file scannable; depth lives in `references/`
7. **Anti-rationalization table** — REQUIRED for multi-step workflows. Format: "What you'll tell yourself" → "The truth." Preempt the 3-5 shortcuts agents will rationalize.

### Anti-Patterns

| Anti-Pattern | Why It Fails |
|---|---|
| "Check if the user wants X, then Y, else Z" — 5 levels deep | Context window burns fast; user gets lost |
| Everything in one 400-line file | Never read past line 150 in practice |
| No phase detection on a multi-mode skill | Ambiguous entry point = bad output |
| Vague description ("helps with skills") | Won't trigger reliably |
| No test cases drafted | You're guessing at quality |

### Anti-Rationalization

| What you'll tell yourself | The truth |
|---|---|
| "The description is good enough" | Descriptions are the #1 reason skills don't trigger. 5 minutes optimizing saves every future user from a miss. Run the eval. |
| "I don't need to test this, it's straightforward" | Straightforward skills fail on edge cases you didn't imagine. The 3 test cases take 2 minutes. |
| "I'll add test cases later" | There is no later. The conversation ends, the skill ships untested, and you'll never come back. |
| "This skill is too simple for progressive disclosure" | If it's over 100 lines, it's not simple. Split it now or watch the model skip the bottom half. |
| "I'll just read the outputs, no need for transcripts" | Outputs show *what* happened. Transcripts show *why*. You can't fix instruction problems from outputs alone. |
| "One more iteration will fix it" | If you've done 3 rounds with no delta, the skill is done. Ship it or rewrite — don't polish. |
| "The user didn't ask for a baseline comparison" | Without a baseline you can't tell if the skill helps or hurts. Run it. Takes the same time as the with-skill run. |
| "I'll checkpoint after I finish this phase" | Context compresses without warning. Checkpoint NOW — after every test iteration, after every improvement. |
| "This feedback is minor, I'll skip it" | Minor feedback from one test case is a pattern across 1000 real invocations. Fix it or document why you won't. |

---

## Reference Files Index

| File | Contents |
|------|----------|
| `references/create.md` | Interview question bank, SKILL.md templates, naming conventions, anti-patterns |
| `references/test.md` | Assertion patterns, trigger-testing procedure, output rubric, borderline case handling |
| `references/improve.md` | Root cause analysis, iteration discipline, rewrite vs. patch, regression prevention |
| `references/optimize.md` | Description A/B testing, trigger phrase bank, false-positive debugging |
| `references/test-cases.md` | Live test cases for the skill under development (written during Phase 1) |
| `references/test-log.md` | Iteration history and scores (checkpoint file — survives compression) |
| `agents/` | Subagent prompts for parallelizing test runs or evaluation tasks |
| `scripts/` | Any automation for running tests or generating reports |
