---
name: run-g_code-gate
description: >
  Chief Engineering's G_code oversight skill. Audits whether Code Reviewer
  caught what they should have, dispatches to QA, and surfaces process
  patterns. Use when a PR is flagged awaiting-qa post-G_code APPROVE.
---

# Run G_code Gate

Chief Engineering oversees the harness. This skill is run when Code Reviewer flips a PR to `awaiting-qa`. Your job is to verify the review was substantive (not a rubber-stamp) and dispatch QA Verifier.

## Scope

- Confirm Code Reviewer's APPROVE has structured findings (not "LGTM")
- Verify they ran tests locally (look for test-output reference in their comment)
- Dispatch QA Verifier
- Pattern-spot for systemic issues

## Inputs

- `awaiting-qa` Paperclip ticket
- The PR URL + Code Reviewer's APPROVE comment
- Plan in vault

## Workflow

### 1. Read the Code Reviewer's APPROVE comment on the PR

```bash
gh pr view <PR_NUMBER> --json reviews,headRefOid
```

### 2. Check structure

The APPROVE must have:
- [ ] "Plan adherence: N/5" with explicit count
- [ ] "Bugs: N found" with explicit count
- [ ] "Test coverage: ..." statement
- [ ] "Conventions: ..." statement
- [ ] At least one test result reference (e.g., `pnpm test` output)

If missing any → chain broken. Block.

### 3. Spot-check vs plan

Read the plan in `vault/decisions/<ticket>-plan.md`. Pick 1 plan step at random; verify the diff actually does what the step says.

### 4. Dispatch QA Verifier

Flip ticket to `awaiting-qa` (was already), comment:
```
✅ G_code chain verified · dispatched @qa-verifier for G2
```

### 5. After QA finishes

If G2 BLOCKs and the issue should have been caught at G_code → flag for the next weekly retro: code-review-pr skill needs tightening.

## Output

A comment on the Paperclip ticket + dispatch to QA.

## Notes

- Don't re-review the code itself; trust Code Reviewer.
- This skill should cost <$0.10. Anything more means you're re-reviewing.
- If Code Reviewer chain-breaks 3+ times → SOUL update proposal.

## Escalation

- Plan adherence consistently rated 5/5 but QA finds plan-deviations → Code Reviewer is rubber-stamping; needs intervention
- Same bug class (e.g., null-deref) escapes G_code 3+ times → propose code-review-pr skill update
