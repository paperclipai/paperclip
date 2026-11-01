# Tool connection health sleep migration audit

Parent: plugin scheduling #17518, local head `faac1bf85c`.
Fresh master inspected during this continuation: `71f06d84dc`.
Branch: `codex/sleep-18-tool-connection-health`.
This is an in-progress audit and failing baseline, not a completed migration.

## Obligation and observed blocker

The aggregate heartbeat calls `tools.sweepConnectionHealth()` at startup and on
its recurring maintenance tick. The health owner selects due connection IDs even
when no eligible connections exist. Its default freshness threshold is fifteen
minutes and its page size is 25. The startup regression on the unchanged worker
expected one startup call after two maintenance ticks and observed three calls.
The recorded command is:

```sh
pnpm --filter @paperclipai/server exec vitest run \
  src/__tests__/server-startup-feedback-export.test.ts \
  -t 'does not rescan idle tool health' --maxWorkers=1
```

The baseline failed with `expected 3 to be 1`. This proves aggregate activation;
real database worker tests must separately prove quiet SQL, deadlines, and producer
reactivation after implementation. A removed startup callback alone is not proof.

## Ownership and policy

`tool-access/catalog/health.ts` owns provider health policy and delegates actual
provider behavior through existing discovery, credential, catalog, and runtime
owners. Preserve this boundary. Shared scheduling must not branch on provider
names or decode their credential payloads.

Existing `tool_connections.health_checked_at` and connection eligibility are the
persistent source of truth. No additional health queue table is needed. Keep the
manual `checkHealth` API and normal use/refresh health updates working. Preserve
the current proactive fifteen-minute policy for eligible external checks unless
a provider's existing event/replay contract makes a check unnecessary. Clearly
name that retained external obligation: scheduling the next real check removes
empty scans but does not make a configured external source network-quiet forever.
Do not extend Cloud alarm coverage or remove active-connection sleep blockers in
this slice.

The current SQL excludes `chat_sdk`, `runtime_auth`, and applications of type
`paperclip_plugin`. The schema couples AI purpose to `runtime_auth`, and
`checkConnectionHealth` returns immediately for AI purpose. Do not claim AI rows
are an uncovered polling case without evidence of supported legacy rows outside
those constraints. PR #14638 separately covers AI health behavior.

Audit voice eligibility, experimental connector disablement, and exceptions before
the existing health update: a skipped check that leaves its timestamp unchanged
must not starve later candidates or cause an immediate retry loop. Keep admission
and authorization failures with their owners. Do not silently disable or delete
connections to manufacture quiet.

## Producer inventory to finish

This list identifies writer families; it does not yet certify complete coverage.
Classify each write by changes to eligibility, saved deadline, or relevant probe
configuration before adding a notification. Excluded transport writers need no
health wake merely because they share a table.

- `tool-access.ts`: direct create/update, examples, gallery install/finalization,
  legacy imports, application replacement/deletion, and credential configuration.
- `tool-access/connections/installs.ts` and `removal.ts`: enablement, removal,
  restore paths, existing transaction ownership and downstream cleanup.
- `tool-access/catalog/health.ts`, `publication.ts`, `discovery.ts`, and
  `aggregator-accounts.ts`: successful and failed probe/catalog results and
  eligibility changes. Health writes must move or cancel the recorded deadline.
- `tool-access/oauth/*`: access finalization, authorization start, direct/cloud/
  Vercel callbacks, client registration, grant/connection refresh, and refresh
  lease bookkeeping. Lease-only writes are not automatically health producers.
- `tool-access/token-broker/service.ts`, `tool-gateway.ts`,
  `tool-oauth-legacy-backfill.ts`, and `github-connection-events.ts`: actual-use
  health observations, credential repair, and access changes.
- Email connections/channels and Slack-search OAuth: determine which existing
  REST/MCP connection writes remain eligible for this health owner.
- Access provisioning, agent routes, smoke-lab setup, AI connection services,
  and chat provider modules: classify supported imports and shared entry points;
  do not attach unnecessary wakes to excluded AI/chat transports.
- Application type changes and company deletion: retain SQL join eligibility and
  remove stale deadlines after cascades. Instance experimental settings are an
  intentional administrative scope, distinct from ordinary tenant mutations.

Use existing transaction notifications before writes, including caller-owned
transactions. Ordinary company mutations must not activate cross-company scans.
Startup reconstruction is a separate instance-owned obligation. Process-local
hints are not a multi-replica or independent-SQL-writer protocol.

## Required verification

- Empty, disabled, archived, excluded-transport, and retained-history quietness.
- Configured eligible future check: no intervening SQL; run at the saved deadline.
- First creation/enablement and changed credentials through real service producers.
- Successful/failed manual probe and catalog/use health updates reschedule correctly.
- Disablement, deletion, and feature changes cancel or restore the proper obligation.
- Page fairness with more than 25 due rows and with an early uncheckable candidate.
- Company scope, outer commit/rollback, a commit during final reconciliation,
  drain/resume, startup reconstruction, admitted shutdown, and failure recovery.
- Keep provider calls outside transactions and avoid concurrent checks that can
  overwrite newer credentials or health observations with an old result.
- Actual query plan on representative retained history, current consumers,
  required build/type gates, and fresh PR review/checks.

## Related work

Open PRs #15448, #15325, and #11910 concern MCP failure classification and continued
usability after transient tool errors. This migration must preserve that owning
policy rather than choose new disablement behavior in the scheduler. The search
also found #14638 for AI health exclusions. Inspect exact diffs before changing
those paths; titles alone do not establish duplication or compatibility.


## Continuation after parent review repairs

The health branch now includes approval backoff/shared matching at `0d3100665d`
and plugin coalescing/shutdown repair at `ba0b6752cd`. The combined parent
regressions pass all 73 cases. Fresh master fetched and inspected is `a0e5166e97`;
its aggregate tick still calls the health sweep. Parent PR checks are still in
progress. The health migration is not implemented or published yet.

Additional owner evidence changes the implementation plan:

- `checkConnectionHealth` can call catalog discovery before writing its final
  health observation. `catalog/publication.ts` itself changes health timestamps,
  config, transport config, and `updatedAt`. A blanket comparison with the
  connection's original `updatedAt` would reject this operation's own writes.
  Concurrency fencing must distinguish a newer external configuration/observation
  from the current probe's owned catalog publication; do not add a naive row-version
  check that silently drops legitimate results.
- `oauth/refresh-leases.ts` changes config and `updatedAt` merely to acquire or
  release its existing refresh lease. Those are active-operation bookkeeping,
  not independent reasons for proactive health work. Do not notify health for
  every config-column write by pattern matching.
- `oauth/connection-refresh.ts` has two different health-relevant transitions:
  reauthorization failure changes status to draft and disables the connection;
  successful token refresh changes credential refs/config while keeping the
  connection usable. The former must cancel eligibility; the latter must refresh
  the owning schedule without a global scan or a credential-refresh feedback loop.
- Experimental setup policy resolves application identity and may reject before
  the current health try/catch writes a timestamp. Disabled candidates therefore
  need an explicit parked state and reactivation from instance feature changes;
  they must not monopolize the bounded due page or lose their configuration.

These are audited constraints, not implemented guarantees. Complete producer
classification and prove these paths before removing the health backstop.

## Implemented producer contract, October 25

The implementation and producer dispositions are now recorded in
[the health lifecycle document](../idle-tool-connection-health.md). Health
creation/setup mutations commit their grant/binding/runtime-slot SQL before the
wake. Direct/cloud/Vercel OAuth activation and refresh disablement, catalog and
actual-use observations, email control, access removal, company deletion, and
feature changes now notify the owner. Voice connections remain covered through
the chat lifecycle; the provider-to-transport mapping stays in the chat catalog,
and excluded SDK chat updates do not notify health work.

The aggregate health scan is replaced by the shared worker. Seventeen lifecycle,
515 startup/tool-access, and 163 gateway/settings cases pass. The first consumer
run exposed an ordinal transaction mock; a real SQL restoration fault preserves
the intended regression and passes. Producer/chat consumers, query-plan evidence,
build, and remote gates remain pending. Master was refreshed to `8415f4a679`;
this uncommitted health branch remains based on the open migration stack, so
final stack reconciliation with master is still required. No merge is authorized.


## Security follow-up: individual refreshes

The company-hint design amplified ordinary connection writes into full company
reads. The current contract scopes individual producers (API/example creation,
setup/rollback, OAuth, gateway, health/catalog, email, voice, GitHub events, access
removal, and Smoke Lab) by company plus connection ID. Existing application
updates in example setup and Smoke Lab use application scopes. Company deletion
and instance feature-settings changes retain broad invalidation. Startup and
broad loads use bounded UUID pages. The health owner still defines eligibility
and provider policy; the shared notification/coordinator layers remain generic.

See `doc/idle-tool-connection-health.md` for the failing amplification baseline,
changed contract, scope-cancellation tests, and verification results. The older
company-hint observations in this audit describe the superseded implementation.

## Acceptance follow-up after the plugin parent merged (October 27)

The actual merged parent is master `96727b3cfefb61f85ffe1fbc29a9b6dd6837efe8`.
All 18 preceding sleep PRs are merged. Historical unmerged-state statements
above describe earlier revisions.

The final producer and retry follow-up is recorded in
[the health lifecycle document](../idle-tool-connection-health.md#acceptance-follow-up-after-the-plugin-parent-merged-october-27).
It preserves the two real installer amplification failures, type-change lock-wait
mutation proof, independent failed-inventory retry regression, fresh database
fixture setup, and verification scope. Metadata-only installer writes do not
invalidate an entire application; actual eligibility changes still do. Inventory
failures do not inherit another company's one-second backlog continuation.
Current-head reviews and CI remain required; these are worker-level guarantees.
