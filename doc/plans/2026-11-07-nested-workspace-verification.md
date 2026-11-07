# Reuse immutable nested workspace verification

An online Git parent can omit imported nested workspaces only after the existing
owner verifies their committed snapshots and current local bytes. The parent
checks that coverage before and after its own capture.

The online importer now creates one private verifier inside its existing complete
source, lifecycle, and copyback fence. Independent topmost child branches use at
most two workers. Descendants run serially within each branch, so recursion
cannot multiply the bound or wait for permits held by its own ancestors.

Each pass still reads the current database references, operation bindings and
recursive child coverage. It also captures every current child tree again, with
the existing local-file, Git, manifest and source-change checks. A previous local
capture never replaces the fresh second-pass capture.

Only the immutable archive check is reused. The proof key binds the complete
snapshot reference, operation and child closure. A successful full ciphertext
hash, GCM authentication, plaintext hash and canonical restore must finish first.
A matching fresh HEAD must retain its ETag and byte length before that proof can
be reused. Missing ETags use full readback and restore. A changed identity evicts
the old proof and forces full authenticated verification; it cannot authorize a
changed payload.

The verifier confirms the same live source-owner transaction before and after
each pass. It rejects use in a different owner scope. The first failure aborts
queued work, and the owner waits for active peers before it removes scratch or
releases the fence. The verifier clears its private proof map at the end of the
import. Proofs do not survive a retry, process exit, transaction change or volume
handover. Separate importer processes do not share this proof.

The offline path retains its existing full verification behavior. There is no
new database marker, provider turn, timer, background scan or larger deadline.
Original sources and remote recovery obligations remain unchanged.

An operator must count up to two logical child verifications for an online Git
parent even when it runs in one Node process. Start with one parent. Confirm its
phase timings, scratch use and completion within the existing budget before
running more parents. This change removes repeated work; local correctness tests
do not prove the completion time of a particular hosted workspace.
