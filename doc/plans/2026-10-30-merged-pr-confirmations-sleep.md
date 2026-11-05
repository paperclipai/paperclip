# Merged pull request confirmation scheduling

The merged-PR confirmation duty previously ran from every heartbeat maintenance
callback, including when there were no merge requests. It loaded all pending
confirmation cards and then applied the merge-only parser in memory.

The interaction service still owns merge-only eligibility, provider access,
automatic acceptance, current resolver authority, audit, and continuation.
The worker registers the existing scoped-deadline helper with a dedicated delivery
topic. Shared scheduling receives interaction/company identities and deadlines;
it receives no GitHub payloads. No database migration is required.

## Durable truth and producers

Pending `request_confirmation` interaction rows remain the durable work source.
The candidate query pages pending cards in bounded groups of 100 and excludes
terminal and hidden issues and linked tool actions. The existing fail-closed
parser is the sole text eligibility source: it requires merge intent and a PR
reference and excludes additional actions, governed actions, and document/attachment targets.
No accepted or cancelled history keeps a deadline alive. A full page without any
merge candidates still advances its keyset cursor; later candidates are not lost.

Ordinary creation registers the topic before inserting a confirmation in its
transaction. Existing confirmation-resolution notifications invalidate its issue
before acceptance, rejection, withdrawal, supersession, and administrative expiry.
Issue status and visibility changes invalidate that issue before their update.
The signal helper joins caller-owned outer transactions; nested savepoint release
is not a commit. Startup reconstructs existing candidates. Direct tool, secret,
and OAuth interaction inserts do not create eligible merge-only work. Company
portability does not import pending interaction rows.

The supported writer model is the instance's ordinary service/API process.
Independent SQL writers must use the same transaction-aware notification contract
or explicitly invalidate/restart the owning worker. Process-local notifications
do not establish a cross-replica ingress guarantee. No permanent database listener
or empty recovery scan is added.

## External observation and retries

The existing normalized `applyPullRequestEvent` to
`sweepMergedPullRequestConfirmations` seam remains available. A normalized merge
hint checks matching references in its company; unrelated tenants and PRs do not
cause provider reads. Existing provider/binding authorization remains unchanged.

A pending candidate can reference a PR whose external changes have no dependable
webhook coverage. Each such candidate retains a five-minute observation deadline.
Resolution, withdrawal, supersession, hiding, or terminal issue state removes the
obligation. Provider/read failures and unknown states retain the candidate, using
the existing scoped helper's 30-second exponential backoff capped at five minutes.
These retries do not scan completed history. Removing candidate reconciliation
requires a proven durable delivery/replay guarantee for every referenced PR,
including the first event after idle and supported non-Cloud installations.

This is candidate-backed external observation. It does not eliminate all polling,
register a Cloud wake alarm, or prove that the host/database suspends. Existing
sleep-safety blockers remain in force.

Startup registers this observation without waiting for live GitHub requests.
The internal resolver invocation accepts an optional host-owned abort signal;
that signal is not part of external-object records or plugin/RPC payloads.
The GitHub owner combines cancellation with a ten-second request budget and
passes it to the actual object fetch and repository-visibility probes, including
response body reads. Shutdown aborts the request and waits for its cancellation;
no post-abort acceptance is committed. A timeout leaves the durable card pending.

## Acceptance evidence

Focused tests use real PostgreSQL, the actual service producers, transaction
signals, coordinator, scheduler, acceptance transaction, and persisted audit and
chat continuation outbox. GitHub state and the direct heartbeat wake callback are
controlled simulation boundaries. The tests do not claim live GitHub delivery or
real agent execution.

Cases cover empty/configured idle and retained terminal history with no recurring
SQL/provider work across old cadence windows; the first ordinary creation;
outer commit/rollback; exact candidate and failure deadlines; withdrawal;
provider failure across drain; standby/resume; restart; tenant-scoped and duplicate
merge hints; latest/superseded cards during provider observation; hidden/terminal
issues; URL targets; no-continuation policy; and shutdown during an in-flight read.
Existing startup and normalized GitHub event tests exercise the changed consumers.
Controlled local HTTP tests hold headers, partial response bodies, 404 probes,
and public-visibility probes. They observe server-side response close after
shutdown within one second, rather than only racing a promise. A shortened
request budget times out a real request; the saved card then accepts after
restart when that same HTTP fixture serves a merged response. Existing GitHub
provider and external-object service tests preserve their authorization behavior.

## Verification follow-up

The original head passed full-workspace typecheck and build. A later required
Linux CI shard failed the unchanged managed-skill maintenance CLI fixture in
`managed-skill-content.test.ts`: it returned `unavailable_or_corrupt_package`
where `local_storage` was expected. Both the isolated case and the complete
unchanged 17-test file pass against fresh local PostgreSQL. The original Linux cause is
not established; that failure is retained and is not called a flake.

After merging current master, the same fixture failed locally because the new
managed-Cloud policy from PR #18350 correctly refuses local disk. A separate
test-only prerequisite commit changes that fixture to the real S3 provider with
a controlled HTTP endpoint, valid fixture credentials, and a stable test key.
It verifies remote reads without seeding or mutating runtime configuration,
rejects corrupt and missing objects, and recovers after restoring canonical bytes.
The full existing 17-test file passes with these failure controls. Production
configuration validation remains unchanged. Current-head required CI remains
the completion gate.

## Cancellation during acceptance

The registered worker passes its optional cancellation signal into the canonical
confirmation acceptance transaction. It rechecks after the issue lock, before
mutation and before commit. Cancellation while an awaited write is blocked rolls
back the interaction, audit and transactional delivery effects. Manual callers
without a signal retain their existing acceptance and rollback behavior.

A PostgreSQL lock wait itself remains unabortable by this signal: stop waits for
the query to unwind. Once the lock is released, cancelled acceptance leaves the
card pending for restart. The existing HTTP request timeout and prompt stop abort
remain unchanged. Actual lock and write-trigger controls verify pending state,
no post-stop wake, and exactly one acceptance/audit/wake on restart.

## Existing limitations outside this migration

Direct non-chat continuation still uses the existing postcommit `wakeup` call.
If that call fails after acceptance commits, the previous periodic sweep also
skipped the accepted row and did not reconstruct the missing wake. This migration
preserves that behavior; a general durable interaction-continuation contract is
a separate follow-up. Real chat bindings retain the existing transactional
`interaction_wakeup` outbox, verified through ordinary creation and acceptance.

The separate review-authority issue tracked in public issue #17704 and PR #17711
remains owned there. The worker isolates candidate failures and preserves current
review authorization; it does not grant a system actor new review authority.
