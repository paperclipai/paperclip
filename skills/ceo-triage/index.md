# CEO Triage

Two cadences: **hourly** (blocker escalation) and **weekly** (issue governance). No issue creation. No productivity reviews.

---

## Hourly Triage — Blocker Escalation

### When to run
On every CEO agent heartbeat (1h interval).

### Steps

1. Call `GET /api/companies/{companyId}/issues?status=blocked` to list all blocked issues.
2. For each blocked issue:
   a. Fetch its recent comments. Check for any comment in the last 24h with `metadata.kind === "blocker_escalated"`.
   b. If NOT yet notified: post ONE comment with:
      - `presentation.kind = "system_notice"`
      - `presentation.tone = "warning"`
      - `metadata: { kind: "blocker_escalated" }`
      - Body: "🔴 {identifier} is blocked — needs board attention. Blockers: {list blocker identifiers if available}."
   c. If already notified within 24h: skip silently.
3. Do NOT change issue status. Do NOT create any issues.

### Completion

Post a single `progress_note` on your current task:
"Hourly triage complete. Scanned {N} blocked issues. Notified: {M}. Skipped (already notified): {K}."

---

## Weekly Governance — Issue Hygiene

### When to run
Once per week (Monday morning, or first CEO heartbeat after weekly rollover). Check if `dayOfWeek === 1` (Monday) and `hourOfDay < 12` to gate this section — only run if this is a fresh Monday triage.

### Steps

**1. Agent assignment audit**

For each agent (call `GET /api/companies/{companyId}/agents`):
a. Fetch all issues assigned to that agent with status `in_progress` or `todo`.
b. For each issue, check that the issue's `goalId` maps to a goal that aligns with the agent's role. If the issue has no `goalId` or the goal is unrelated to the agent's mandate, flag it.
c. Flag format: post a `system_notice` comment on the flagged issue with `metadata.kind = "assignment_mismatch"`, body: "⚠️ {identifier} may be misassigned — assigned to {agent_name} but goal context suggests {expected_owner}. Review needed."
d. Only flag if no `assignment_mismatch` comment exists in the last 7 days.

**2. Rogue backlog scan**

a. Fetch all issues with status `todo` or `backlog` and no `parentId` and no `goalId` (unanchored root issues).
b. For each unanchored issue older than 7 days, search for semantically similar issues in the same company (compare titles).
c. If a likely duplicate or parent candidate is found:
   - If the existing issue is a clear parent: call `PATCH /api/issues/{rogueId}` with `parentId: {parentId}` to subordinate it.
   - If it's a likely duplicate: post a `system_notice` comment on the rogue issue with `metadata.kind = "possible_duplicate"`, body: "⚠️ This issue may duplicate {identifier} — '{title}'. If so, please close this one or merge scope."
d. If no duplicate found but the issue is unanchored and stale (>14 days, no comments): post a single `system_notice` with `metadata.kind = "stale_unanchored"`, body: "📋 {identifier} has been in backlog >14 days with no goal or parent. Assign a goal or close it."
e. Only flag/link if no governance comment (kinds: `possible_duplicate`, `stale_unanchored`) exists in the last 7 days.

**3. Related-work linking**

For each pair of issues in the same goal that share strong keyword overlap in their titles/descriptions and are NOT already related:
- Call `POST /api/issues/{id}/relations` to create a `related` relation between them.
- Limit: at most 5 new relations per weekly run to avoid over-linking.

### Completion

Post a single `progress_note` on your current task:
"Weekly governance complete. Assignment flags: {A}. Rogue issues processed: {R} (linked: {L}, flagged: {F}, stale notices: {S}). Relations added: {X}."

---

## Hard Rules (both cadences)

- Do NOT create new issues under any circumstances during triage.
- Do NOT spawn or trigger productivity reviews.
- Do NOT re-flag issues that already have an unexpired governance comment (24h for hourly, 7 days for weekly).
- Do NOT change issue status except as explicitly described.
- Keep all comments brief — one sentence per item, no prose blocks.
