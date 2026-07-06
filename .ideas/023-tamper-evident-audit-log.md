# 023 — Tamper-Evident Audit Log

## Suggestion

Paperclip's vision is autonomous companies that are **governable and accountable**, and the
`activity-log.ts` service already records who did what. But a plain append table is only as
trustworthy as the database it lives in — anyone with DB access (a rogue admin, a compromised
agent that reaches the data layer, a bad migration) can silently rewrite or delete history. For
a system that's supposed to be the auditable system-of-record for an AI workforce making real
business decisions and spending real money, "trust me, the log is accurate" isn't enough.

Make the audit log **tamper-evident** via a hash chain: each entry includes the hash of the
previous entry, so any retroactive edit or deletion breaks the chain and is detectable. You
can't prevent a sufficiently privileged actor from changing the DB, but you *can* make it
impossible to do so undetectably.

## How it could be achieved

1. **Hash-chain the log.** Add `prevHash` and `entryHash` columns to the activity-log table.
   `entryHash = H(prevHash ‖ canonical(entry))`. Each new entry chains off the last — a
   standard, cheap append-only-verifiability construction.
2. **Verification endpoint/job.** A routine (`routines.ts`) re-walks the chain and verifies
   integrity, raising a high-severity inbox alert if a break is found. Operators (and a Holding
   Company, idea 007) can run on-demand verification before trusting a report.
3. **Periodic anchoring (optional).** Periodically record the latest `entryHash` somewhere
   outside the DB — a separate store, a signed file, or even an external timestamp — so even
   wholesale rewrites of the table can't forge a consistent chain. Reuses the storage layer.
4. **Cover the decisions that matter.** Ensure the high-stakes events are in the chain: budget
   changes, approvals/overrides, agent hires, secret access (idea 021), emergency stops
   (idea 014), and cross-company actions (idea 007).
5. **Exportable proof.** Include the chain + verification in company exports
   (`company-portability.ts`) so an operator can hand a regulator/partner an audit trail whose
   integrity is independently checkable.

## Perceived complexity

**Low–Medium.** The mechanism is well-understood and the logging service already exists — the
core change is computing/storing two hashes per entry and adding a verifier. The fiddly parts
are (a) canonical serialization so hashes are stable and reproducible, (b) handling concurrent
writes to a single chain without contention (may need a per-scope chain or a short serialization
point), and (c) deciding what to do operationally when verification *fails*. External anchoring
is an optional hardening tier to add later.
