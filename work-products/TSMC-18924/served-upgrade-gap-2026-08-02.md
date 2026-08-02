# Served Paperclip upgrade gap — 2026-08-02

## Status

The customized `live` branch is not a fast-forward candidate. Its current base
is 119 upstream commits behind `upstream/master` and contains 286 commits not
present upstream. The upstream tip observed during maintenance was
`8540ce2973204a8938cd05ac18fbc37c6434f8f5`.

A direct live merge is therefore outside the safe reinstall/repair action. It
must be rehearsed from the clean committed snapshot, with the served process
quiesced only after the rehearsal is green.

## Relevant upstream fixes to reconcile

- `e4b0152ca` — keep an agent invokable after workspace-sync conflict failure.
- `a0dbe2104` — stand recovery down when operator cancellation is the latest
  activity.
- `b163c6c47` — preserve hot-restart intent across path upgrades.
- `fc5a30805` — managed install, update, and service lifecycle.
- `1ee1275f1` — persist ACPX process identity across hot restart.
- `cd7f84965` — preserve recovery hand-back wake liveness.
- `4813ed3f0` — harden embedded Postgres test startup with bounded retry.

These are candidates for a rehearsed upstream merge or patch-equivalence
review. They were not applied blindly to the operating tree during incident
containment.

## Safe next gate

1. Tag or otherwise record the clean served snapshot and verified database
   backup.
2. Create an isolated worktree from that snapshot.
3. Merge `upstream/master` in the isolated worktree and resolve conflicts
   without altering the served checkout.
4. Run the full test, typecheck, build, migration, API-health, and adapter
   canary gates there.
5. Quiesce production only for the final fast rollback-capable cutover.
