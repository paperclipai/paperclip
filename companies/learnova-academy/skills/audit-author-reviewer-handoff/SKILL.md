---
name: audit-author-reviewer-handoff
description: >
  Chief Content's handoff audit skill — pattern-spot whether Author and Reviewer
  are working as a clean two-agent chain. Spot when Reviewer is rubber-stamping
  or Author is consistently failing. Use weekly during chief retro or on
  suspicion.
---

# Audit Author-Reviewer Handoff

The two-agent chain is sacred. This skill verifies it stays that way.

## Scope

- Look at last 7 days of Author drafts + Reviewer comments
- Spot rubber-stamping, redundant-blocking, or chain-breaking patterns
- Propose SOUL or skill updates if patterns repeat

## Inputs

- Last 7 days of `vault/blogs/*/draft.md` and `vault/courses/*/<chapter>.md`
- Last 7 days of Paperclip ticket comments from `@content-reviewer`
- `vault/retrospectives/content-author/*.md` and `vault/retrospectives/content-reviewer/*.md`

## Workflow

### 1. Pull the data

```bash
# Drafts authored last 7d
find vault/blogs vault/courses -name "*.md" -mtime -7

# Reviewer comments
gh api ... # or Paperclip task API
```

### 2. Compute these patterns

**Rubber-stamping signal:**
- Reviewer PASSes that have ≤2 dimension scores (incomplete review)
- Reviewer PASSes where a downstream gate (G3 alignment, QA fact-check) found a blocker the Reviewer should have caught
- Same Reviewer PASS template repeated verbatim (no per-draft adaptation)

**Author repeat-failure signal:**
- Same blocker on revision 2+ (Author didn't address Reviewer's feedback)
- Same blocker class (e.g., URL 404) across 3+ different Author drafts in 7 days
- Author hits revision 3+ on a single draft

**Healthy chain signal:**
- Most drafts PASS on revision 1-2
- BLOCKs are specific, line-anchored
- Reviewer dimension scores vary (not all 5/5; not all 4/5)

### 3. Decide

If rubber-stamping detected:
- Score Reviewer 5/5 outputs flagged
- Propose SOUL update for content-reviewer: "Score with explicit per-dimension justification"
- Propose `content-review` skill addition: "Reject any review that's missing dimension scores"

If Author repeat-failure detected:
- Score Author retros to find pattern
- Propose `course-author` skill update: "Add URL pre-validation check before flipping status"
- Possibly propose ticket DOD tightening with chief-content

### 4. Write audit report

`vault/retrospectives/_team/content-handoff-audit-W<n>.md`:

```markdown
# Content handoff audit · Week <n>

## Drafts processed: <N>
## PASSes on revision 1: <N> (<%>)
## PASSes on revision 2+: <N>
## Blocked (≥3 revisions): <N>

## Rubber-stamping flags: <N>
<details>

## Author repeat-failure flags: <N>
<details>

## Proposed updates
- [ ] content-reviewer SOUL: <change>
- [ ] course-author skill: <change>
- [ ] Ticket DOD template: <change>
```

### 5. Hand to CEO via weekly retro

The CEO batches your proposals into the next G4 SOUL-update queue.

## Output

`vault/retrospectives/_team/content-handoff-audit-W<n>.md`.

## Notes

- Don't run this skill more than weekly — patterns need data.
- Don't propose SOUL changes from a single bad draft. Look for repeat patterns.
- Don't side with Author against Reviewer or vice versa. Both are doing their jobs; the pattern tells you which side needs adjustment.

## Escalation

- Rubber-stamping confirmed (3+ flags in a week) → escalate to CEO same heartbeat (this is a quality crisis)
- Author retraining needed → escalate to CEO; possibly the model or ticket DOD is wrong
