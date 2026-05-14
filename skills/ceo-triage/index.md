# CEO Triage

Hourly triage: scan all blocked issues that need attention, post ONE warning if not already notified in the last 24h, then stop. No issue creation. No productivity reviews.

## When to run
- On timer (CEO agent heartbeat, 1h interval)

## What to do

1. Call `GET /api/issues?status=blocked&companyId={companyId}` to list all blocked issues
2. For each blocked issue:
   a. Check its recent comments (last 24h) for any comment with `metadata.kind === "blocker_escalated"`
   b. If NO such comment exists: post ONE comment with `presentation.kind = "system_notice"`, `presentation.tone = "warning"`, and `metadata: { kind: "blocker_escalated" }`. Body: "🔴 {identifier} is blocked — needs board attention. Blockers: {list blocker identifiers if available}."
   c. If already notified within 24h: skip silently
3. When done: set the issue status to `in_review` if it was `in_progress`. Otherwise leave unchanged.
4. Do NOT create any new issues.
5. Do NOT spawn productivity reviews.

## Completion

After scanning all blocked issues, post a single `progress_note` comment on your current task:
"Triage complete. Scanned {N} blocked issues. Notified: {M}. Already notified (skipped): {K}."

Then set your current task status to `in_review`.
