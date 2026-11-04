# Prospective counter definitions v1

Source-only proposal, fixed before any current-build counter run. This packet
does not release execution. Every record is diagnosticOnly and ineligible for
the fifty unprofiled acceptance arms. V8 CPU sampling stays off; one-second
process.cpuUsage, memory and event-loop counters remain resource observations.
No Inspector Profiler method is called. Loopback Inspector may only acknowledge
the final observer flush before ordinary Playwright server teardown.

* `queryBuildAttempts`: invocations of installed postgres-js connection.build
  after string construction. Includes transaction commands, retries and all
  server-Node database traffic. It is neither wire calls, successful SQL, implicit
  transactions nor append-only SQL. Retain first-keyword totals, never SQL text,
  parameters, connection credentials or error messages from SQL.
* `beginInvocations` / `beginAcknowledged` / `beginRejected`: explicit sql.begin
  API entry, successfully awaited BEGIN query, and rejected API scope. The API
  rejection can follow work, COMMIT, rollback or connection failure; it is not
  another BEGIN-wire failure. Keep unacknowledged BEGIN invocations separate.
* `outerCommitAcknowledged`: only after the installed outer scope's actual
  `await sql\`commit\`` succeeds. `outerCommitRequested` and
  `outerCommitFailed` are separate; a rejected COMMIT is never acknowledged.
  Observer timestamp follows the driver ACK; it is not the database commit
  instant. Outer scope success counts once even with nested savepoint scopes.
* `outerRollbackAcknowledged` / `outerRollbackFailed`: only after the original
  rollback await succeeds / rejects. Callback or uncaught query rejection is
  `outerWorkRejected`; it is distinct from rollback failure. Re-throw the exact
  original product error, preserving postgres-js's existing selection semantics.
* Prepared transaction request/ack/failure is separate from COMMIT. Successful
  PREPARE is not committed durable work. Nested savepoint scope start, work
  success/rejection and rollback-to ACK/failure are separate. A nested scope
  success is not RELEASE SAVEPOINT or an outer transaction commit.
* `postCommitEvents` and identity-hashed marker records come from the unchanged
  port persistence-observer callsite after the outer database transaction
  resolves. Duplicate receipts do not increment new-event/marker counters.
  Identity collision fails capture. Later consequential callback failure does
  not erase an already committed event. Public port calls/events, groups, errors
  and elapsed sums remain distinct; nested public calls may overlap. Histogram
  sizes are Node public port input counts, never Rust available-Vec sizes.
* Normalized queue counts/depth/peak observe the actual AsyncQueue buffered
  values and accepted pushes. They exclude collector/inflight/raw transport
  buffers. Original source clocks minus postcommit markers is a separate
  full-path backlog proxy. Lossless source/durable joins are still mandatory.
* Local run-log append timing is overlapping async elapsed work, not CPU.
  Node CPU/RSS/heap/external counters describe only server Node; sampled maxima
  are not instantaneous peaks. Event-loop delay uses a 20 ms histogram and count;
  one-second p95/max is not an adequately sampled user-tail or p99 estimate.
  Committed-identity storage is capped at 262144; exceeding it fails capture.

Ratios require a complete normal non-Stop journey, exact owning raw reports,
all six module hooks exercised, no observer failure/overflow, an independent
finalization ACK with file hashes and zero pending bytes/records, independent
durable source joins and zero unmatched normal backlog. Keep actual failures,
rollbacks, retries, timeouts, censoring and cleanup in raw evidence. A valid
flush alone never qualifies failed workload or implies no later commits.

For non-Stop CPU/SQL/transaction-per-event ratios require at least five interior
sample intervals and no more than 10% boundary uncertainty. Use the actual case
window `[epochMs, settledAtMs]` for terminal drainage. A separate window through
`h5.independentDrain.verifiedAtMs` includes all later verification; label it
separately rather than substituting one boundary for the other. Prelude/setup is
outside both windows. For each cumulative numerator choose the last sample
strictly before the window and first strictly after as bracket boundaries; U is
their difference. L is last-minus-first of samples inside the window. For CPU,
U sums bracketed intervals and L sums fully interior intervals (skip the first
interior sample's interval). Require U>0,0<=L<=U and `(U-L)/U<=0.10` for every
reported numerator, including outerCommitAcknowledged; a CPU/SQL eligibility
pass cannot silently qualify a noisier transaction ratio. Require>=6 interior
samples to supply>=5 fully interior intervals. Publish interior/bracket windows,
deltas, boundary overshoots and exact durable-event denominators; otherwise
retain raw counters without ratios. Whole-app bracketed costs include background
work and verification.
Do not use a BEGIN-attempt denominator as completed transactions. Normalized
events, unique postcommit events and durable compact markers are different
denominators; show each chosen count explicitly. Finalization after Stop or a
short window supplies no CPU/event or transaction/event ratio claim.

Current build pins are per-variant exact hashes from the 4a83 inventories plus
installed patched postgres3.4.9. Unknown bytes or missing/duplicated anchors
fail closed. No old-profile or unversioned fallback. Local byte-identical B0
port text permits a source-transform test, not serving-build qualification.
Actual B0/B1/B2 smoke must still prove all hooks and independent flush/cleanup.
The present B2 ca7 binary is an unoptimized reference, not final Rust candidate.
Resolver qualification binds original compiled disk bytes and preserves the
existing frozen H5d composer-Stop fixture loader. It does not assert that
downstream fixture-loaded code equals the original file or add another resolver
override. The ordinary fixture loader/leaf command must remain independently
pinned and checked in the actual normal-assembly smoke.

External PostgreSQL, Runner/provider CPU, PID-birth sampling, syscall/state-save
counts and actual Rust Vec sizes are not implemented by this packet. They need
their own reviewed probes and quiet-window release. PG rows returned or table
counters are not rows examined; carry exact EXPLAIN rows×loops separately.
