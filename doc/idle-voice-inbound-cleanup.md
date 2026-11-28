# Inbound voice cleanup without idle scans

Inbound admission cleanup runs from committed changes and saved deadlines. It
uses the shared delivery coordinator and scoped deadline worker. The recurring
voice maintenance lane now owns only history retention and reports, which remain
separate migrations. Manual reconciliation remains available for diagnostics.

## Ownership and durable state

An unbound admission owns the existing provider call until approval or guest
intake binds a voice session. The live-session recovery service then owns physical
termination. Admission cleanup never also ends that bound call. It can request
ending through the session row and copy the owner's confirmed terminal result.

Approval now commits the admission binding with the authorized session insert or
guest promotion. Expiry cannot see an old approving admission after that session
commits. Cleanup also locks and rechecks the admission before claiming it; a
candidate from an earlier scan is not permission to terminate a call. Both paths
lock admission before session. Provider requests run outside SQL transactions.
Older interrupted handoffs are repaired only when the existing session matches
the approval actor, authority, request key, task, token, generation and credential
identity. Conflicting ownership retains an error/retry instead of terminating a
call or inventing authority.

The migration adds three nullable fields to `chat_voice_inbound_calls`, not a new
queue table:

- `cleanupConfirmedAt` separates admission status from physical termination.
  An ended or denied admission can still have an unconfirmed provider leg.
- `cleanupNextAttemptAt` survives crashes and restart. The claim saves the retry
  before contacting the provider.
- `providerAccountId` records the account authenticated by the signed pre-call.
  Cleanup can use a rotated key after verifying its account. A key for another
  account cannot inspect or terminate this call. Older admissions lack that
  evidence and require their original credential fingerprint.

The migration is replayable. It backfills only historical ended rows whose old
writer or signed lifecycle audit proves termination. It leaves old guest-denial
rows uncertain when their ended label did not prove physical cleanup. Those rows
receive a real check rather than disappearing as completed history. The partial
index covers unconfirmed admission identities. Startup reads at most 100 rows
per scope refresh and reconstructs deadlines across pages. The historical
backfill commits keyset batches of at most 1,000 rows through the migration
runner. Migration 0395 preserves the landed checkpoint lineage through 0394.

## Deadlines and quiet state

Rejection returns after its decision transaction commits. Its notification wakes
the registered cleanup worker; the HTTP request does not wait for provider account
verification, inspection, or hangup. The saved denial immediately rejects further
unauthorized call input while physical termination remains tracked separately.

Pending unbound admissions retain their original two-minute approval or ten-minute
guest-intake expiry. Rejection is immediately due. A cleanup claim saves a
30-second retry before provider I/O. An unconfirmed end receipt keeps that retry;
inspection, a confirmed end receipt, or a signed terminal callback clears it.
Unexpected failures also receive the shared worker's bounded failure backoff.
Neither a timeout nor an end request by itself proves termination.

Bound live calls leave no admission cleanup deadline. Their existing live-session
worker owns expiry, authorization checks and provider cleanup. Its terminal write
signals admission settlement. Healthy passive provider inspections do not wake
this admission worker. Confirmed history and configured-but-idle endpoints leave
no recurring admission SQL or provider requests.

Feature disable does not discard an outstanding call. Cleanup continues with its
saved identity. Missing credentials or account mismatches retain debt; they do not
permit use of a replacement account. No recovery path creates or redials a call.

## Producer audit

| Producer | Commit boundary and wake |
| --- | --- |
| Signed pre-call admission | Endpoint-scoped intent before insert in the quota transaction |
| Approval or rejection | Admission-scoped intent before the locked state write |
| Authorized session insert or guest promotion | Admission binding and intent inside the reservation transaction |
| Guest intake task/session binding | Session-scoped voice change before insert; admission binding shares the transaction |
| Pending tool detects expiry | Admission intent before the expired-state write |
| Signed terminal lifecycle/report callback | Session and admission intents before confirmed termination writes |
| Live-session termination, inspection or no-resource expiry | Existing voice-change boundary also signals inbound settlement |
| Reply provider confirms the call ended | Inbound session intent before the terminal session write |
| Configuration, authority or connection changes | Existing scoped voice-change composition |
| Cleanup claim, legacy handoff repair and confirmation | Admission intent in the owning transaction |

Notifications are process-local hints. Existing database rows remain truth. The
shared transaction layer delays hints until outer commit and retains uncertainty.
Other replicas and independent SQL writers require an explicit integration.

History retention cannot delete unconfirmed cleanup. Company deletion locks its
endpoints, matching ingress, then asks the voice owner to prove inbound cleanup is
settled. It rejects deletion while a provider obligation remains. This prevents
cascade deletion from erasing the evidence needed to finish cleanup. Existing
voice-history foreign-key restrictions otherwise remain unchanged.

## Verification and limits

Real PostgreSQL tests cover confirmed-history quiet, exact expiry, restart,
transaction rollback/outer commit, stale discovery, old interrupted handoffs,
bound-session ownership, unconfirmed requests, failures, fair paged backlog,
drain/resume, shutdown, retention protection, and deletion protection. Production
service tests exercise signed ingress, rejection, account mismatch and rotation,
feature disable, and atomic ordinary/guest approval. See the dated
[inbound cleanup audit](plans/2026-10-25-voice-inbound-cleanup-sleep-audit.md) for
commands, counts and preserved failures. The current-parent acceptance records
266 distinct passing cases and the guarded batching, restart and approval
regressions. Earlier counts in that audit belong to their stated revisions.

These changes do not migrate history retention or call reports, extend Cloud's
external wake coverage, relax sleep eligibility for live calls, or prove actual
host/database suspension. A registered in-process deadline alone cannot wake
stopped compute.
