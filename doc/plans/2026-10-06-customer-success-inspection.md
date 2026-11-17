# Customer-success inspection foundation

Approved scope: one designated Paperclip agent uses its existing persistent
Ed25519 identity plus a verified, active managed-run credential. Cloud owns
short-lived grants, older-stack human approvals, durable replay fencing and audit.
Customer stacks expose an explicit read-only API before ordinary auth middleware.
Automatic eligibility is seven days from stack creation (or recorded pooled
claim), with no user/account/signup-age condition. The eventual bot and morning
schedule are separate work.

## Implementation and qualification

- Paperclip: `codex/customer-success-inspection`, updated to master `ac8f3eb14`.
- Cloud: same branch name, isolated worktree `/private/tmp/paperclip-cloud-customer-success`, updated to master `044160d0`.
- Core strict JWT/run-authority, versioned permit routes, explicit resource catalog,
  read-only transactions, instruction/workspace/asset/snapshot readers implemented.
- Cloud broker, dedicated signer, durable store/migration, admin-session/capability
  routes, registration/kill switch/approval/audit UI and agent client implemented.
- Core catalog, file restrictions, active-run authority and existing identity tests pass.
  The complete database snapshot remains equal before and after catalog reads.
- Coordinated qualification passes with a real managed process agent, separate
  source/customer PostgreSQL databases, two Cloud broker replicas, HTTP permits,
  runtime-role append-only enforcement, one-year retention, the existing wake
  controller with a local provider, and binary file reads through Cloud.
- Cloud root suite: 2,544 pass, 73 expected skips. Admin web: 779 pass. The 23
  inspection checks cover scoped approval review, replay, revocation, bounded
  anonymous audit traffic, and database-pool concurrency. Routing/wake smoke passes.
- Browser acceptance verified native admin login, navigation, exact target review,
  approval, revocation, immediate disablement and persistence after refresh.
- Full core typecheck and build pass. The local broad test run recorded 14,277
  passes and four failures in existing suites (two timeouts and two PR-metadata
  mock assertions); all three affected suites pass on isolated reruns. The full
  CI matrix passes at the implementation head. Public PR #15405 and its companion
  Cloud PR carry current review/check status. No deployment or customer enablement.

## Required invariants

No database credentials, owner-login fallback, private identity material, tenant
sessions/memberships/activity/read receipts or routine Slack alerts. Preserve
existing content redactions, file restrictions and raw-trace suppression. Audit
before dispatch and before release; recheck run, policy, grant and age exception.
The source bearer never reaches customers. Tenant permits are short-lived,
operation-bound and consumed atomically in Cloud. Human approvals override age
only, freeze exact targets, and can authorize later runs of the same identity.

Deploy core support before Cloud migration/broker/UI. Disabled by default; staging
and internal canary qualification precede customer enablement. Default retention
one year; rollback/reenrollment/exclusions/retention runbooks accompany both PRs.
