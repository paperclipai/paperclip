---
name: run-g0-gate
description: >
  Chief Content's G0 oversight skill. Audits whether the Content Reviewer
  is gating drafts correctly, surfaces patterns across recent reviews, and
  blocks routing to G3 if the chain is broken. Use when a content draft is
  flagged as awaiting-g3 by Chief Content.
---

# Run G0 Gate

Chief Content's responsibility is NOT to re-review the draft (that's the Content Reviewer's job). It's to ensure the **chain itself worked** — that the Reviewer reviewed properly before flipping the status.

## Scope

- Verify the Author → Reviewer chain produced a valid PASS comment
- Spot-check that Reviewer didn't approve with caveats or skip URL verification
- Block routing to G3 if chain integrity is suspect

## Inputs

- `awaiting-g3` Paperclip ticket
- The draft markdown in vault
- Reviewer's PASS comment on the ticket

## Workflow

### 1. Pull the ticket + draft

```bash
gh api graphql -f query='...'   # or via Paperclip task API
```

Read:
- The Author's draft at `vault/<path>/draft.md`
- The Reviewer's PASS comment

### 2. Validate the Reviewer's PASS comment

Check it has all 5 dimensions scored:
- [ ] Accuracy ≥ 4/5
- [ ] Brand voice ≥ 4/5
- [ ] Structure ≥ 4/5
- [ ] Completeness 5/5
- [ ] Spam-brain ≥ 4/5

If any dimension is missing or <4/5 with a PASS → **chain is broken**. Route ticket back to `awaiting-g0` with a comment to Reviewer.

### 3. Spot-check Reviewer's URL verification

Pick 1 random factual claim from the draft. Fetch its cited URL with WebFetch. If it 404s or contradicts the draft → chain broken. Block.

### 4. Spot-check completeness against the original ticket

Compare the draft's frontmatter (`learning_objectives`, `whats_new`) to the ticket's success criteria. If anything required is missing → block.

### 5. Decide

- **PASS** — flip status to `awaiting-seo` (SEO Optimizer pre-flight before G3) with comment:
  ```
  ✅ G0 chain integrity verified · routing → @seo-optimizer pre-flight
  ```
- **BLOCK** — flip back to `awaiting-g0` with specific reason; comment to Reviewer

## Output

A comment on the Paperclip ticket + status flip.

## Notes

- This skill is meta-review. Don't re-review the content itself; trust your Reviewer.
- If the same Reviewer chain-breaks 2+ times in a week, escalate to weekly retro: maybe the content-review skill needs tightening.
- Chain integrity check should cost <$0.10. If you're spending more, you're re-reviewing.

## Escalation

- Reviewer chain broken 3+ times → propose Reviewer SOUL update
- Spot-check URL fails → block + ping Author + Reviewer for revision
