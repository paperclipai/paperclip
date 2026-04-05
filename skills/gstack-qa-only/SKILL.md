---
name: gstack-qa-only
description: >
  Report-only QA mode — test the site and document bugs, but don't fix them.
  Use when you want a QA report without automatic fixes. Use when asked to
  "qa-only", "just test", "find bugs but don't fix", or "report-only qa".
---

# /gstack-qa-only: Report-Only QA

Test the web application and document bugs WITHOUT fixing them. This is the read-only version of `/gstack-qa`.

## Difference from /gstack-qa

- **Does NOT fix bugs** — only documents them
- **Does NOT require clean working tree** — read-only mode
- **Does NOT commit anything** — report only
- **Faster** — no fix loop

## Setup

Same as `/gstack-qa`:
- Parse target URL, tier, scope
- No clean working tree check needed (read-only)

## Workflow

### Phase 1: Initialize
```bash
mkdir -p .gstack/qa-reports/screenshots
```

### Phase 2: Authenticate (if needed)
Same as `/gstack-qa`

### Phase 3: Orient
Same as `/gstack-qa`

### Phase 4: Explore
Same as `/gstack-qa`

### Phase 5: Document Issues
Same as `/gstack-qa`

### Phase 6: Compute Health Score
Same as `/gstack-qa`

### Phase 7: Report

Write the report — same format as `/gstack-qa`, but:
- No "Fix Status" field (always "not fixed")
- No commit SHAs
- Include "Recommended Actions" section for each issue

## Report Format

```markdown
# QA Report (Report-Only): {domain}
Date: {date}
Duration: {duration}
URL: {url}
Mode: Report-Only (no fixes applied)

## Summary
- Total issues found: N
- Health score: {score}
- Top 3 issues: [list]

## Issues

### ISSUE-001: {title}
- **Severity:** critical/high/medium/low
- **Category:** functional/ux/visual/console/accessibility
- **Page:** {url}
- **Repro steps:**
  1. Navigate to {url}
  2. Click {element}
  3. Observe {problem}
- **Evidence:** screenshot-{id}.png
- **Recommended Action:** [how to fix]

## Next Steps
Run `/gstack-qa` to fix these issues automatically, or fix manually.
```

## Important Rules

1. **Never fix anything.** This is read-only mode.
2. **Never commit.** Report only.
3. **Include recommended actions.** Help developers understand how to fix.
4. **All other rules from /gstack-qa apply.**
