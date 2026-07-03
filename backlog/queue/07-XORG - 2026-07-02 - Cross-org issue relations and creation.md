---
task-id: "07-XORG"
status: ready
priority: high
story-points: 8
model: opus
effort: high
---

# Cross-org issue relations + cross-org issue creation

## Problem

The multi-org escalation flow is crippled by two same-company restrictions:

1. **`blockedByIssueIds` is same-company only.** `server/src/services/issues.ts:4091-4098`
   filters related issues by `companyId` and throws
   `unprocessable("Blocked-by issues must belong to the same company")`. A Communities issue
   (e.g. COM-114) escalated to LearnLoop (LEA-69) cannot carry a real blocker edge — the link
   lives in a comment, and there is no auto-resume when the LEA issue completes. Every
   Community-Manager → CTO escalation loses the dependency semantics.

2. **Agent principals are locked to one company.** `server/src/middleware/auth.ts` binds agent
   tokens to a single `company_id` (`:152` rejects mismatched agent records; `:193` scopes agent
   API keys). An agent in COM cannot file the LEA escalation issue itself — today only board/user
   principals with multi-company memberships can.

**Owner directive (2026-07-02): open this up — any principal (board or agent) can create any
issue on any organization, and blockers can cross organizations.**

## Scope

### A. Cross-company `blockedByIssueIds`
- Remove the same-company filter in the blocker-set path (`issues.ts:4091-4098`): resolve
  blocker ids globally, not `eq(issues.companyId, companyId)`.
- `issueRelations` rows are keyed by one `companyId` — decide representation for a cross-company
  edge (store the *dependent* issue's companyId on the row, or add `relatedCompanyId`); migrate
  schema accordingly.
- `assertNoBlockingCycles(companyId, …)` must walk the relation graph **globally** so a
  COM→LEA→COM chain still detects cycles.
- The auto-resume path (blocker reaches `done` → dependent issues unblock/wake) must fire
  cross-company: completing LEA-69 must wake/unblock COM-114 regardless of org.
- `cancelled` blockers still do NOT count as resolved (existing semantics, now cross-org).
- API read side: `blockedByIssueIds` in issue payloads may now contain foreign-company issue ids —
  ensure GET endpoints and any expansion (identifier rendering like `LEA-69`) resolve them.

### B. Cross-org issue creation + commenting for agents
- Allow agent-authenticated principals to `POST /api/companies/{otherCompanyId}/issues` and
  `POST /api/issues/{foreignIssueId}/comments`.
- Preserve attribution and audit: `createdByAgentId` keeps the real agent id; record the agent's
  home company on the row or in the audit trail so a foreign-org issue shows who (and from
  where) filed it.
- Keep write scope limited to **create issue + comment** on foreign orgs. Foreign-org status
  changes, deletion, checkout, goal/project mutation stay same-company (out of scope here).
- Instance-wide default: allowed for all orgs (single-operator instance). Implement as a policy
  check in one place so it can later be tightened per-company (e.g.
  `allowCrossCompanyIssueCreation` company setting defaulting to true) — flag existence is enough,
  no admin UI needed.

## Acceptance criteria (in-pipeline only)

1. Unit/integration test: setting `blockedByIssueIds` on issue in company A referencing an issue
   in company B succeeds; GET returns the cross-company id.
2. Test: cross-company cycle (A1 blocked-by B1, B1 blocked-by A1) is rejected by cycle detection.
3. Test: completing the company-B blocker unblocks/wakes the company-A dependent (auto-resume
   parity with same-company behavior).
4. Test: `cancelled` cross-company blocker does not resolve the dependency.
5. Test: an agent token from company A creates an issue in company B; `createdByAgentId` is the
   agent's id; response is 201 (previously 401/403).
6. Test: an agent token from company A comments on a company-B issue successfully.
7. Test: an agent token from company A still CANNOT change status of a company-B issue (403).
8. Schema migration (if any) applies cleanly; existing same-company relations unaffected
   (regression tests pass).
9. Typecheck + lint + full test suite green (`pnpm check` / repo equivalent).

## Out of pipeline (follow-ups)

- Verify against the live instance at `localhost:3100`: relink [COM-114](/COM/issues/COM-114)
  with a real `blockedByIssueIds` → LEA-69 edge.
- Update agent instruction docs (`~/.gsai/paperclip-agents/roles/community-manager/HEARTBEAT.md`
  §6, CMO Specific-Instructions, Communities-Hub CLAUDE.md files) to restore the first-class
  blocker pattern instead of comment-links.

## Pointers

- Blocker validation: `server/src/services/issues.ts:4091-4098`
- Relations delete/insert: `server/src/services/issues.ts:4101+`
- Cycle check: `assertNoBlockingCycles` (same file)
- Agent auth scoping: `server/src/middleware/auth.ts:152`, `:193`
- Implementation plan: `backlog/attachments/07-XORG-cross-org/implementation-plan.md`
