# Support Case Assessment: v0.4.0 Deep Planning — Plan Documents, Review Gates, Decomposition

**Feature**: Structured plan documents with revision history, milestone-based review gates, and approved-plan decomposition into child issues
**Assessed by**: Support Engineer
**Date**: 2026-08-16
**Related**: VOY-1195, VOY-1196, VOY-1197, VOY-1203, VOY-1204, VOY-1209, VOY-1252
**Release**: v0.4.0-alpha

## Feature Overview (User Perspective)

Deep Planning introduces a structured plan document system that replaces ad-hoc plan descriptions with revisioned, sectioned, milestone-tracked plan artifacts on issues. Key capabilities:

1. **Structured Plan Documents** — Plans carry structured metadata (sections, milestones, status) alongside a free-form markdown body. Each plan update creates a revision, enabling diffing and rollback awareness.

2. **Milestone Tracking** — Plans can define milestones with acceptance criteria and status tracking (`pending`, `in_progress`, `completed`, `cancelled`).

3. **Review Gates** — Agents can create approval gates on plan revisions. Gates are linked to milestones and acceptance criteria. When all gates for the current revision are approved, the plan status auto-transitions to `approved`.

4. **Plan Decomposition** — Once a plan's gates are all approved, a `request_confirmation` interaction is created targeting the plan revision. A **board user** must accept this confirmation (agents cannot accept). Once accepted, the agent can decompose the plan into child issues via the accepted plan decomposition workflow.

5. **Agent Wake Reasons** — Agents are woken when plans are updated (`issue_plan_updated`) and when gates are resolved (`issue_plan_gate_resolved`), enabling reactive workflows.

For users: Plans are now visible in the Issue Detail page with section navigation, milestone progress bars, and gate status indicators.

### Plan Board UI (VOY-1252)

A dedicated **Plans** page is available at `/plans` in the sidebar (under the Work section). Operators can:

- **Browse plans** — list view with status badges (`draft`, `in_review`, `approved`, `superseded`), section count, and milestone progress indicators
- **Filter and sort** — by status and priority; click through to plan detail
- **View plan detail** — structured sections with markdown rendering, milestone status, version info, and metadata display
- **Manage approval gates** — see pending gates with acceptance criteria, approve/reject with a comment, view gate history; an "All gates approved" transition notice appears when the plan is ready to auto-approve
- **Browse revision history** — revision list with diff metadata (who, when, version); select a revision to view an inline diff (added/removed/unchanged lines)

The plan UI also mounts inside the Issue Detail page when an issue has a plan document (plan document sections, approval gates section, revision browser).

## Potential User Confusion Points

1. **"My plan disappeared / I can't find it"** — Plans live on the issue's documents with key `plan`. Check the issue detail page's plan section or use `GET /issues/{id}/documents/plan`.

2. **"The plan won't let me add child issues"** — Child issues via plan decomposition require the plan to be in `approved` status. All review gates for the plan's current revision must be approved. Check gate status with `GET /issues/{id}/plan/gates`. Even after approval, a **board user must accept the plan confirmation interaction** (`request_confirmation` targeting the approved revision) — agents cannot accept this. Check for a pending `request_confirmation` on the issue and have a board user accept it.

3. **"I created gates but nothing happened"** — Gates don't auto-resolve. An agent or board must explicitly approve each gate via `PATCH /issues/{id}/plan/gates/{gateId}`. Auto-approval only happens when all gates are resolved to `approved`.

4. **"The plan is still in draft but I was expecting it to auto-publish"** — Plans do not auto-transition to `approved` without gates. Create gates and have them all approved, or the plan stays `in_review` (once a gate exists) or `draft`.

5. **"I got a 'stale revision' error updating the plan"** — The `baseRevisionId` field must match the current latest revision. Provide the latest `latestRevisionId` from the plan document to avoid 409 Conflict.

6. **"Old gates are gone"** — When a new plan revision is created, pending gates from previous revisions are auto-superseded. This is by design — each revision gets fresh gates.

7. **"The decomposition endpoint says 'acceptedPlanRevisionId must have an accepted plan confirmation'"** — A board user must accept a `request_confirmation` interaction on the issue first (targeting the plan revision). Agents cannot accept plan confirmations — only board users can. See the FAQ entry "How do I turn a plan into actual work?" below for the full flow.

## FAQ

**Q: How do I create a plan?**
A: Use `POST /issues/{issueId}/documents/plan` with your plan body and optional `planMetadata` (sections, milestones).

**Q: How do review gates work?**
A: Create gates on `POST /issues/{issueId}/plan/gates`. Each gate targets a milestone and lists acceptance criteria. Agents or board operators approve/reject via `PATCH`. When all gates for the current revision are `approved`, the plan status changes to `approved`.

**Q: What happens when I update a plan after creating gates?**
A: Existing pending gates are auto-superseded. You need to create new gates for the updated revision.

**Q: How do I turn a plan into actual work?**
A: The full flow:
   1. Create a plan document via `POST /issues/{issueId}/documents/plan`
   2. Create review gates via `POST /issues/{issueId}/plan/gates`
   3. Have gates approved via `PATCH /issues/{issueId}/plan/gates/{gateId}` until all are approved — the plan auto-transitions to `approved`
   4. The agent creates a `request_confirmation` interaction on the issue (targeting the approved plan revision) — this is the explicit waiting path, and the issue moves to `in_review`
   5. A **board user** accepts the confirmation via the board UI — **agents cannot accept plan confirmations**
   6. Once accepted, use `POST /issues/{issueId}/accepted-plan-decompositions` to create child issues
   This replaces the previous ad-hoc decomposition workflow.

**Q: Can I edit a milestone after creating it?**
A: Milestones are part of `planMetadata`. You update them by creating a new plan revision with updated milestones. Each revision has its own snapshot of milestones.

**Q: What's the difference between sections and milestones?**
A: Sections organize the plan content (like chapters). Milestones track progress (like checkpoints). Milestones can have acceptance criteria and gates; sections are purely informational.

**Q: I rejected a gate but my plan still says in_review — shouldn't it auto-approve the other gates?**
A: No. A rejected gate means that gate's acceptance criteria were not met. The plan will not auto-approve while any gate is rejected. Even if all other gates are approved, the rejection blocks the plan from transitioning to `approved`. To proceed, create a new plan revision with fixes addressing the rejection, then create fresh gates for that revision.

## Troubleshooting

### User reports "stale revision" error

1. The `baseRevisionId` in the request didn't match the server's latest revision
2. Fetch the current plan document: `GET /issues/{issueId}/documents/plan`
3. Get the `latestRevisionId` from the response
4. Retry the update with the correct `baseRevisionId`

### User can't decompose (child issues not created)

1. Verify the plan is in `approved` status
2. Check gate status: `GET /issues/{issueId}/plan/gates`
3. All gates for the current revision must be `approved`
4. The `acceptedPlanRevisionId` must reference an approved revision
5. If gates exist but aren't approved, resolve them first
6. **Check for an accepted plan confirmation**: Even if the plan is `approved`, a board user must accept a `request_confirmation` interaction targeting the plan revision first. Agents cannot accept — the board must. Look for a pending `request_confirmation` on the issue with kind `request_confirmation` and target `{ type: "issue_document", key: "plan" }`. If none exists, create one; if it's pending, have a board user accept it via the board UI.
7. If the endpoint returns `422: "acceptedPlanRevisionId must have an accepted plan confirmation"`, this confirms the acceptance step is missing

### Gates not appearing after plan update

1. Gates are linked to a specific revision
2. After updating the plan, previous gates are superseded
3. Create new gates for the current revision: `POST /issues/{issueId}/plan/gates`
4. Verify by listing gates: `GET /issues/{issueId}/plan/gates`

### Gate won't approve (returns error)

1. Check that the gate ID exists and is `pending`
2. The gate status field must be `"approved"` or `"rejected"` — not `"pending"` or `"superseded"`
3. Ensure you have permission (must have write access to the issue)
4. If the gate was superseded, create a new gate for the current revision

### Plan status stuck in draft despite having gates

1. Gates auto-supersede on plan update — the revision ID changes
2. List gates for the current revision: `GET /issues/{issueId}/plan/gates?revisionId={latestRevisionId}`
3. If no gates exist for the current revision, create them

## Error States

|| Error | User sees | Root cause | Recovery |
|---|---|---|---|---|
|| 409 Conflict on plan update | "Stale baseRevisionId" | `baseRevisionId` doesn't match latest revision | Fetch current plan doc to get latest revision ID |
|| 404 on plan GET | "Plan document not found" | No plan exists on this issue | Create one with POST |
|| Gate not resolving | Unexpected error | Gate already superseded or doesn't exist | List gates to verify state |
|| Decomposition fails | 400 error | Plan not approved or revision mismatch | Check plan status and gates |
|| Decomposition fails | 422: "acceptedPlanRevisionId must have an accepted plan confirmation" | No accepted `request_confirmation` interaction targets this revision | Have a board user accept the plan confirmation first via the board UI |
|| Decomposition fails | 422: "acceptedPlanRevisionId must belong to the source issue's plan document" | Revision is from a different issue's plan | Use the correct revision ID from the target issue's plan document |
|| Gate creation fails | Missing issue | Issue ID not found | Verify issue exists |
|| 403 on agent actions | Forbidden | Agent trying to access another agent's scope | Use correct agent authentication |

## Related Documentation

- [Plan Documents API Reference](/docs/api/plans) (Paperclip)
- [Issue API Reference](/docs/api/issues) (Paperclip)
- `/documentation/releases` — v0.4.0-alpha release notes
- [Memory & Knowledge Support Case Assessment](support-case-v0.4.0-memory-knowledge.md)

## Escalation Path

| Issue | Severity | Escalate to | Notes |
|---|---|---|---|
| Plan update creates phantom child issues | Critical | CTO | Data integrity issue — immediate escalation |
| Gates approve but plan status doesn't change to approved | High | Staff Engineer | Check for rejected gates (blocks auto-approval). If no rejected gates exist, auto-transition logic may have failed. |
| Decomposition creates issues outside the plan's scope | High | CTO | Security/scope violation |
| Plan revision diff returns empty or wrong data | Medium | Staff Engineer | Diff computation issue |
| Agent not woken on plan update or gate resolve | Medium | Staff Engineer | Wake reason may not be delivered |
| Milestone acceptance criteria lost on revision | Medium | Founding Engineer | Milestone snapshot fidelity issue |
| Decomposition fails with 422: "acceptedPlanRevisionId must have an accepted plan confirmation" | Low | First line support (guide board user) | No accepted plan confirmation exists for this revision. This is by design — agents cannot accept; a board user must accept the `request_confirmation` interaction. Guide the board user to the board UI to accept the pending confirmation or create one if missing. |