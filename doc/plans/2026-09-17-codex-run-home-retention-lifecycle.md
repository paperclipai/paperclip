# Codex Run-Home and Retained-Session Lifecycle — Architecture Review

## Recommended architecture

Keep one private `CODEX_HOME` per local Codex run. Treat its lifecycle as two
ordered records: the raw run home and a bounded, best-effort-redacted retained
counterpart. Normal deletion remains gated on runtime close, terminal run and
directory ownership, zero open handles, age beyond grace, and exact retained
JSONL coverage.

`buildRuntime` owns a startup rollback record as soon as the run home exists. A
failure before any transport-start attempt may remove that provably unused home.
If cleanup fails, or transport startup was attempted, Paperclip preserves the
home, writes a versioned quarantine marker, and emits
`acpx.codex_run_home.quarantine`.

Every run-home sweeper treats the producer's sibling `<run-id>.quarantine` file
as an unconditional deletion veto before retained-proof or terminal-orphan
evaluation. A directory or symlink with that suffix is not the producer shape
and fails closed as an invalid marker path.

Retention reads at most 8 MiB per JSONL and 32 MiB per run before synchronous
redaction. Any oversize, unreadable, invalid-text, or partial copy quarantines
the raw home. The redactor recognizes JWTs only when the first segment decodes
to an object with an `alg` field, avoiding destructive matches on ordinary
dotted identifiers. It also covers AWS access-key IDs, context-labelled AWS
secret keys, inline datastore DSN passwords, PEM private-key blocks, and Stripe
live/test keys. Each completion manifest records both the total redaction-rule
hit count and the count for every retained file so fidelity loss is auditable.
Completed retained runs use a 30-day TTL plus per-agent caps of 1,000 runs and
1 GiB. Cleanup is auditable and dry-run by default; destructive execution
requires an explicit operator flag and is not scheduled. Cap selection
continues past protected raw-home counterparts, and the manifest reports any
residual run/byte excess that fail-closed exclusions prevent it from removing.

The 8 MiB per-file bound deliberately favors evidence integrity over reclaim
rate: an oversize transcript is never truncated and never replaces the raw
copy. Operators should treat `sanitized_session_retention_failed` quarantine
events/markers as the oversize-rate signal. Raising the bound or adding a
streaming redactor requires a separate measured design and review.

Hard-loss homes without a counterpart remain undeletable. The raw-home dry-run
manifest classifies them and separately reports whether the stricter review
preconditions hold: terminal ownership, at least seven days old and at least
twice the normal grace, zero open handles, and zero raw JSONL. The report does
not implement or authorize recovery deletion.
Inspection failures, hard-loss-orphan counts, and bytes at risk are explicit
aggregate fields and CLI summary values. Empty run wrappers are reported but
never mutated by the sweeper because they can be a live startup window.
Sibling quarantine files with neither a raw run wrapper nor a retained
counterpart are also listed separately with their age, byte size, and empty-file
state. Marker-only directories, symlinks, and inspection failures are listed as
operator-visible inspection failures instead of disappearing from the manifest.
They are not automatically deleted. Local Codex runtimes are closed before
retention and are never placed in the warm-runtime cache; a regression test pins
that lifecycle constraint.

## Risks

- Security: best-effort redaction cannot prove removal of novel secret formats;
  retained files stay private and time/size bounded. Redaction-hit counts show
  that content changed but do not prove every credential was found.
- Data integrity: deleting retention while a raw home exists could invalidate
  the normal four-condition delete proof; the retention sweeper blocks it.
- Operational: a hard crash can bypass in-process marker creation. The dry-run
  sweeper makes terminal no-counterpart homes explicit without deleting them.
- Capacity: the fail-closed 8 MiB file limit can quarantine most bytes for a
  heavy run. That is accepted until a bounded streaming design is separately
  reviewed; truncating the only evidence copy is not an acceptable fallback.
- Race safety: a transport-start attempt makes home usage ambiguous, so startup
  rollback quarantines rather than inferring that the home is unused.

## Migration impact

- Files affected: `packages/adapter-utils/src/acpx-engine/execute.ts`, both
  lifecycle sweepers and tests, and `doc/DEVELOPING.md`.
- Downtime: no.
- Rollback plan:
  1. Disable any manually configured retention cleanup invocation.
  2. Revert the code change; no database migration or format rewrite is needed.
  3. Preserve existing raw homes, retained runs, manifests, and markers.
  4. Re-run both sweepers in dry-run mode and compare manifests before any later
     cleanup decision.

## Files likely affected

- `packages/adapter-utils/src/acpx-engine/execute.ts`
- `packages/adapter-utils/src/acpx-engine/execute.test.ts`
- `packages/adapter-utils/src/command-redaction.ts`
- `packages/adapter-utils/src/command-redaction.test.ts`
- `packages/adapter-utils/src/acpx-engine/run-home-sweeper.ts`
- `packages/adapter-utils/src/acpx-engine/run-home-sweeper.test.ts`
- `packages/adapter-utils/src/acpx-engine/session-retention-sweeper.ts`
- `packages/adapter-utils/src/acpx-engine/session-retention-sweeper.test.ts`
- `doc/DEVELOPING.md`

## What must be tested

- Pre-deploy: startup cleanup success/failure, partial transport startup,
  oversize/unreadable retention, exact-counterpart delete, terminal no-counterpart
  reporting, credential redaction and benign dotted-identifier preservation,
  per-file redaction counts, TTL/cap dry runs, raw-home exclusion, orphan-marker
  inventory, no-warm-save behavior, marker cleanup, typecheck, and exact-head CI.
- Post-deploy: live success, cancellation/failure, active-run exclusion, and
  hard server-loss canaries; confirm quarantine events and both dry-run manifests.

## Approval gates

No no-counterpart raw-home deletion is implemented. Do not schedule retained
transcript deletion, run either sweeper destructively, deploy, or merge until the
operator approves the exact head and a fresh independent Claude review reports
no material lifecycle or data finding.

## Decision rationale

This design preserves the existing automatic-delete invariant and adds evidence
where process loss previously created silent permanent orphans. Automatically
deleting terminal no-counterpart homes was rejected because terminal status and
age do not prove that no session data would be lost. Keeping retained data
forever was rejected because it merely relocates unbounded sensitive growth.
Streaming arbitrary JSONL through the existing synchronous redactor was rejected
because that redactor's contract requires a caller-side bound; fixed-size reads
make the memory and redaction input limits explicit. Truncation was rejected
because it would permit deletion of evidence absent from the retained copy.
Blindly matching every three-part dotted token as a JWT was rejected because it
silently corrupts common filenames and identifiers; structural header validation
keeps the credential rule narrow. Automatic cleanup of marker-only records was
rejected because the marker is durable incident evidence and no operator-approved
recovery policy exists for it.
