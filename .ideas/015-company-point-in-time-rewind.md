# 015 — Company-Level Point-in-Time Rewind

## Suggestion

Autonomous agents make irreversible-feeling messes: a CEO agent reorganizes the whole task
tree badly, a bad strategic directive cascades into dozens of misguided sub-issues, an agent
floods the board. Paperclip has instance-level database backups
(`routes/instance-database-backups.ts`) and company import/export
(`company-portability.ts`), but no **company-scoped "undo"** — a way to rewind *one* company
to a known-good state without nuking the whole instance or doing a manual export/reimport
dance.

Add **point-in-time rewind for a single company**: periodic lightweight snapshots of a
company's state (org, issues, goals, budgets, documents) and a one-click "restore this company
to <timestamp>" — a save-state for an autonomous business.

## How it could be achieved

1. **Reuse the portability serializer.** `company-portability.ts` already knows how to
   serialize/deserialize a whole company. A snapshot is a timestamped, content-hashed export
   stored in the existing storage layer (`server/src/storage/`); restore is an import scoped to
   that company id.
2. **Automatic checkpoints.** Take a snapshot on a routine (`routines.ts`) and *before* high-
   risk events — a CEO strategic re-plan, a bulk issue mutation, an org-chart change — so
   there's always a recent clean point to fall back to.
3. **Diff before restore.** Show the operator what restoring would change (issues created/
   destroyed since the snapshot, spend in the interval) so rewind is an informed choice, not a
   blind revert.
4. **Non-destructive option.** Offer "restore into a new company" (fork) as well as in-place
   rewind, so an operator can inspect the old state side-by-side — and so a Holding Company
   (idea 007) could A/B two strategies from the same checkpoint.
5. **Guard rails.** Rewind itself is a heavyweight, audited action gated behind confirmation
   and logged to `activity-log.ts`; it should auto-Drain (idea 014) the company first so a
   restore doesn't race live runs.

## Perceived complexity

**Medium–High.** Snapshot creation is largely free given the existing serializer, but
*restore* is the hard part: doing it transactionally, deciding what to do with in-flight runs
and external side effects (an agent's snapshot can't un-send an email it sent), and keeping
referential integrity for issues/documents/work products. Frame the guarantee honestly —
rewind restores Paperclip's *control-plane* state, not the outside world — and ship fork-style
restore (safe) before in-place rewind (destructive).
