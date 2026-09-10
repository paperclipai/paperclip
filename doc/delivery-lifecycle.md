# Delivery Lifecycle

Automated GitHub delivery for code issues: candidate registration, scoped review
reads, a durable per-repository merge queue, verified merge receipts, and an
unforgeable Done gate.

Schema lives in `packages/db/src/schema/delivery.ts`. Contract types live in
`packages/shared/src/types/delivery.ts`; request validators in
`packages/shared/src/validators/delivery.ts`. Services live in
`server/src/services/delivery/`. Routes are mounted from
`server/src/routes/delivery.ts`.

## 1. Concepts

- **Delivery unit** — one reviewed candidate: canonical repository + target
  branch + immutable accepted revision, one pull request, one receipt. A unit
  covers one or more issues (`delivery_unit_issues`); exactly one row is the
  primary issue.
- **Delivery phase** — `not_started | in_review | ready_to_merge | merging | done`.
  Separate from issue status. A blocked unit keeps the phase it had and records a
  machine `reasonCode`.
- **Submission vs acceptance** — `submit` records the candidate head in
  `delivery_units.head_sha`. `accepted_head_sha` is written only by the
  reconciler, after fresh authoritative GitHub evidence passes for that exact
  head. Nothing else may set it, and the merge executor merges only the accepted
  head. A new head, a failed requirement, or an unreadable authoritative source
  withdraws acceptance; a repaired head is re-accepted automatically by the next
  reconcile.
- **Artifact readiness** — `artifactReady` means the reviewed artifact exists.
  It gates dependent development, not completion or acceptance. Delivery
  completion always requires a verified merge receipt.
- **Receipt** — immutable `delivery_receipts` row written only after the merged
  revision is proven reachable from the target branch. It is the only evidence
  the Done gate accepts.
- **Repository identity** — `delivery_repositories` keyed by GitHub's immutable
  numeric id, with owner/name re-verified on every policy write so a rename
  cannot split the queue.

## 2. Issue statuses

Canonical statuses add `ready_to_merge` and `merging`
(`packages/shared/src/constants.ts`). Board order:
Backlog → Todo → In Progress → In Review → Ready to merge → Merging → Done, with
`blocked` and `cancelled` supported.

`ready_to_merge` and `merging` are written only by the delivery controller.
`issues.update` rejects them from every other caller, and issues cannot be
created in them. The board UI renders them; agents never set them.

## 3. Done gate

`server/src/services/delivery/done-gate.ts` runs inside the row-locked
`issues.update` transaction, so every mutation path (UI, API, agent, bulk,
recovery, native runner, watchdog) passes through it.

- Non-code issue: allowed only when `issues.delivery_disposition` holds an
  explicit `reasonCode` and `message` **recorded by an operator session**
  (`actorType: "user"`). Worker-written kinds or dispositions never self-serve
  a non-code closure; `disposition` and `dependencies` writes are operator-only
  at both the route and the service. Never inferred from status or title.
- Code-delivery issue: allowed only when a unit covering it is `merged` **and**
  its receipt names a `mergedSha` verified for the same target branch. A closed
  (unmerged) pull request is explicitly not evidence.
- Code delivery is detected from explicit signals only: `issues.delivery_kind`,
  a linked delivery unit, a linked `pull_request` work product, enrollment in
  an enabled project policy, **or a project workspace whose `repoUrl` points at
  a GitHub repository with no policy yet**. Absence of a policy never lets new
  code tasks reach Done: genuine non-code still closes through an explicit
  operator disposition, with no fabricated pull request.
- A parent requires its own verified delivery **plus** every open child delivery
  obligation resolved.

## 4. Policy

One policy per project (`delivery_policies`), versioned on every write. Auto-merge
requires a persisted policy with an `authorization` record naming the approving
operator, and the connection/repository must resolve.

An explicit GitHub connection resolves its Authorization binding from its grant,
not an arbitrary connection-row secret. System delivery accepts exactly one
active personal grant owned by an active non-viewer company member, or one active
default organization grant. Personal secret ownership and declarations are
checked through audited user-secret resolution. Ambiguous, revoked, disabled,
wrong-company, or per-agent authorization fails closed without falling back to
company tokens. This connection boundary currently supports GitHub.com only.

Any material scope change — repository, target branch, merge method or mode,
required checks, Greptile/independent-approval requirements, connections, or
deployment disposition — voids the standing authorization. The operator must
re-authorize the new scope explicitly; a fresh authorization in the same write
re-authorizes at once. Pausing or resuming never changes the authorized scope.

`autoDeployDisposition`:

- `none` — merging to the repository default branch has unknown deployment
  behavior and is blocked; non-default targets are allowed.
- `block_merge` — never merge.
- `no_auto_deploy` — operator has verified that merging does not trigger
  deployment (for example, repository deployment triggers were removed).
  Authorizes merging only; deployment remains separately governed. Record
  trigger-verification evidence in the policy authorization statement and
  pause delivery before restoring automatic deployment triggers.
- `authorized` — operator has recorded deployment authority for this target.

`mergeQueueMode`:

- `serialized` — merge the head of the queue with the accepted revision pinned.
- `native_merge_queue` — enqueue into GitHub's merge queue (GraphQL
  `enqueuePullRequest`); never merge directly.

`requiredChecks` are matched by name against commit statuses plus check runs;
missing or failing required checks block.

`requireIndependentApproval` (default `true`) requires a reviewer **other than
the pull request author** to have approved the **exact head under evaluation**.
It is not conditional on connection identity: there is no self-approval
exemption. It fails closed when the author identity is unknown, when no approval
exists for that exact commit, or when the only approvals are the author's.
Approvals are derived from each reviewer's latest review state, so a later
`DISMISSED` or `CHANGES_REQUESTED` supersedes an earlier `APPROVED`, and an
approval recorded for an older commit never counts for a newer head. An
approving review for a different revision is `review_head_stale`.

Never force push, never admin bypass, never accept stale evidence.

## 5. Queue

`delivery_queue_entries` is keyed by `(repository_id, target_branch)` and shared
across every company project that delivers into that repository, so
cross-project collisions serialize on the same rows. Ordering is topological
(`must_merge_after` dependencies first) then priority then ready time.
Independent repositories run concurrently.

Leases always expire (`delivery_queue_entries.lease_expires_at`); an expired
lease returns to `queued` during the next sweep. There are no indefinite local
project locks. A transaction-scoped PostgreSQL advisory lock serializes the
held-lease check, topology reads, and candidate update for each repository and
branch. While any entry is leased, no second lease is granted. Merge attempts
recheck owner, epoch, and expiry after evidence collection, immediately before
either GitHub merge or queue admission. A lost lease returns without modifying
the current owner's state; lease loss during a merge is reconciled instead of
repeating the side effect.

## 6. Dependencies

`delivery_dependencies`:

- `needs_artifact` — development may start once the depended-on unit's exact
  head stands **accepted** on fresh evidence. Only then does the controller
  wake the dependent issue's owner, through the real heartbeat dispatcher
  (idempotent per dependent unit + accepted head). A worker `artifactReady`
  boolean alone never wakes dependents and never presents as accepted.
- `must_merge_after` — orders delivery; the queue refuses to lease a unit whose
  dependencies are not merged or cancelled.

Cycles and cross-company/cross-repository edges are rejected on write.
Parent/child issue structure is deliberately not a delivery dependency.
Dependency edges are operator-governed.

## 7. PR following, repair, and receipts

- Event-driven: GitHub `pull_request` webhooks call
  `reconciler.reconcilePullRequest` for the matching unit
  (`server/src/services/github-connection-events.ts`).
- Fallback: `sweepAllCompanies` reconciles every open unit and runs the merge
  sweep on the heartbeat scheduler interval.
- A new remote head or a blocking finding revokes readiness, holds the queue
  entry, and wakes the implementation owner with a bounded, deduplicated repair
  request (`delivery_repair_attempts`, max 3) through the real heartbeat
  dispatcher. After the bound the unit escalates instead of looping. Owner
  wakes that cannot dispatch escalate to the operator rather than sitting as
  bare rows.
- Findings are persisted in `delivery_findings`. A disposition is recorded but
  never dismisses unilaterally: `disputed` findings keep blocking, and any
  finding still reported on the accepted head reopens.
- Only authoritative reads decide acceptance. If `getChecks` or `getReviews`
  fails, the evidence for that dimension is `null`, which the requirement
  evaluator blocks on (`provider_unknown`); cached metadata is display-only and
  is never reused as merge evidence. The merge executor re-reads checks,
  reviews, and (when required) Greptile for the accepted head immediately
  before merging, and the receipt records that fresh evidence — never cached
  metadata. A required Greptile review must name the exact accepted head.
- Merge outcomes are verified with `compareCommits(mergedSha, targetBranch)`
  before the receipt is written: the candidate is proven included only when
  the target branch is `ahead` of it (or `identical`). A receipt is only
  issued while the accepted revision is still the current head. Unknown
  outcomes block and reconcile again.
- Operator pause and cancel are never overwritten by in-flight reconciliation:
  a paused unit keeps its operator blocker until an explicit resume, terminal
  units (`merged`, `cancelled`) never leave their state, and pausing or
  resuming a terminal unit is rejected.

## 8. API

All routes are company-scoped and activity-logged.

- `GET /api/issues/:id/delivery` → `DeliverySummary`.
- `GET /api/companies/:companyId/delivery?projectId=` → `{ items: DeliverySummary[] }`.
- `POST /api/issues/:id/delivery` actions:
  - `submit` `{ headSha, baseSha?, sourceBranch, artifactReady, coveredIssueIds?, targetBranch? }`
    with exact 40-hex revisions. Submit binds the authoritative open pull
    request and verifies its exact remote head: a failed read, a missing PR,
    or a head/branch mismatch blocks registration. An agent may only cover
    issues assigned to itself.
  - `reconcile`, `retry` (retry never resets the merge-attempt bound)
  - `feedback` `{ findingId, disposition: fixed|disputed|already_addressed, explanation }`
  - `pause` / `resume` / `cancel` (operator only)
  - `disposition` `{ kind: code|non_code, reasonCode, message, owner?, nextAction? }` (operator only)
  - `dependencies` `{ needsArtifactIssueIds?, mustMergeAfterIssueIds? }` (operator only)

## 9. Publication handshake

The **trusted framework broker is the only candidate publisher**: it imports the
exact offline object, creates the immutable per-issue/head branch, and opens the
pull request with the host GitHub identity. Native Paperclip does not create
branches or pull requests; a second publisher would double-execute PR creation.

Native `POST /api/issues/:id/delivery {action:"submit", headSha, baseSha?,
sourceBranch, artifactReady, coveredIssueIds?, targetBranch?}` binds an
already-published candidate:

- It resolves the canonical repository and target branch from the persisted
  policy; no caller-supplied repository, URL, or credential is accepted.
- It finds the open pull request for `sourceBranch → targetBranch` and binds it.
  The remote head is authoritative: a failed read, a missing PR, or a
  head/branch mismatch blocks registration (`provider_unknown`,
  `candidate_required`, `head_stale`).
- An agent actor must present the **publication capability**: the existing
  runtime tools token with the `github_credentials` scope
  (`server/src/runtime-tools-token.ts`) in `X-Paperclip-Publication-Capability`.
  Header-only: no `Authorization` bearer fallback. It is signed by the
  instance secret and rejected when presented by a browser session. The claims
  are bound to the authenticated actor: `company_id` must match the issue
  company, `sub` must equal the authenticated agent id, and `run_id` must
  equal the authenticated run id
  (`server/src/services/delivery/publication-capability.ts`). A capability
  minted for one agent or run cannot be replayed by another. It proves the
  trusted broker acted; it is never acceptance by itself.
- `artifactReady` is a worker-declared development signal only. It cannot make a
  candidate mergeable; acceptance requires independent review/check evidence on
  the accepted head.

## 10. Greptile

Greptile is read through the governed MCP tool gateway
(`toolGateway.readConnectedTool`). The controller allowlists the tool names
(`get_merge_request`, `list_merge_request_comments`) and the argument keys
(`name`, `remote`, `defaultBranch`, `prNumber`), requires a `read` risk tool,
and derives every argument from the delivery unit. Control-plane reads run
under the same operator tool policies and rate limits as any other tool call;
a deny or a spent budget fails closed. **Both** reads are required: a failed
comments read is a failed read, never a silent partial success. A missing or
unusable connection fails closed with the `greptile_unavailable` blocker. When
Greptile is required, its reviewed head must be the exact head under
evaluation. An addressed flag is not acceptance: acceptance requires native
GitHub review/check evidence on the accepted head.

## 11. Reconciliation

`GET /api/companies/:companyId/delivery/reconciliation` classifies every Done
issue as `code_verified | code_unverified | non_code | unknown` with an outcome.
Only verified receipts surface as provenance. `POST` records an operator
reconciliation, idempotent per `(companyId, idempotencyKey)`; it never reopens
tasks or moves branches. An operator `code_verified` claim without a receipt is
verified remotely first — exact-SHA claim, the enrolled repository and target,
and revision proven included in that branch via `compareCommits`. For completed
work predating delivery units, reconciliation imports a merged unit and immutable
historical receipt; related issues share the same verified unit. Direct publication
requires the submitted head to equal the included revision. A historical PR must
also prove its merged state, target, head, and merge revision through GitHub.
Historical receipts label review evidence as `historical`, not fresh approval.
Their merge method is `unknown`: today's policy cannot describe an earlier
publication. The rewrite flag comes from a separate remote head-inclusion check.
A PR already tracked by another live unit must be reconciled there instead of
being imported. Replayed keys return the original record before importing; a key
belonging to another issue is rejected. Disabled or paused policies still permit
read-only historical verification against their enrolled repository and target.
Policy/issue changes during verification abort the import. Unverifiable claims
remain `code_unverified`; reconciliation never republishes an old branch.

## 12. Required setup

- A GitHub tool connection in the company vault (policy `githubConnectionId`).
- A Greptile MCP connection when `requireGreptile` is set.
- A project workspace `repoUrl` (or `repositoryUrl` in the policy write) pointing
  at the repository.
- An operator authorization record on the policy before enabling auto-merge.

## 13. Verification

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```
Narrow regression coverage lives in
`server/src/services/delivery/delivery-lifecycle.test.ts`: the Done gate
(controller-only delivery statuses, explicit non-code disposition, worker
disposition refusal), review summarization (dismissal supersedes approval,
per-reviewer latest state, approval commit linkage), merge-inclusion direction
(`ahead`/`identical` prove inclusion, `behind` does not), exact 40-hex boundary
revisions, material scope-change detection, the requirement rules (failed
authoritative reads, missing author, self-approval, wrong-head approval,
failing/missing required checks), the acceptance transition (accept, revoke on
regression, automatic re-acceptance of a repaired head, new head),
publication-capability binding (cross-agent/cross-run/cross-company/board
rejection), repository URL parsing, phase retention, and MCP payload unwrapping.
Service/route/DB-boundary regressions live in
`server/src/__tests__/delivery-lifecycle-boundary.test.ts` (embedded Postgres):
concurrent queue single-flight, lease revocation during review for both merge
modes, Done through the real issue mutation on a GitHub project without a policy,
atomic fail-closed submit, covered-issue authorization, Greptile
partial-read failure, policy authorization invalidation, reconciliation
downgrade, pause/disposition guards, and bounded retry.

The candidate publisher is the framework broker; see
`/Users/mirko/.paseo/worktrees/0is1eoku/delivery-integration` (framework repo) for
`delivery_submit_candidate` wiring.
