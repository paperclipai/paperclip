# Transcript retention operations

Paperclip raw run logs, Cursor adapter transcripts, and transcript-derived
database content have a seven-day primary-store retention period. Database
backups remain restricted disaster-recovery copies for their separately
approved 30-day window.

## Safety model

- The utility is a dry-run unless `--apply` is passed.
- Only Paperclip runs with a recognized terminal status and an unambiguous
  `finished_at` older than the single UTC cutoff are eligible.
- Queued, running, scheduled-retry, held, and terminal runs without
  `finished_at` are excluded.
- An active Paperclip issue-tree hold protects runs linked to that issue.
  Additional run IDs can be held with the comma-separated
  `PAPERCLIP_TRANSCRIPT_RETENTION_HOLD_RUN_IDS` environment variable.
- Cursor files are deleted only when their UUID matches an eligible run's
  recorded session/external-run ID and no active, recent, held, or ambiguous
  run references the same session.
- A file whose modification time is newer than the cutoff fails closed: the
  sweep reports a partial result and preserves that run's database content and
  pointers for investigation.
- Logs contain counts, bytes, cutoff, exclusions, and failures only. They never
  contain transcript content.

## Dry-run and enforcement

From the repository root:

```bash
pnpm transcripts:retention
pnpm transcripts:retention -- --apply
```

The apply operation first proves that the current service identity owns and can
read/write each transcript root. It then changes sensitive ancestors and
directories to `0700`, files to `0600`, and writes the prior modes to:

```text
~/.paperclip/instances/default/data/retention/permissions-rollback-*.json
```

Only after those checks does it delete approved old files and scrub
`heartbeat_runs.result_json`, stdout/stderr excerpts, and run-event
message/payload content. Status, timing, usage, cost, liveness, log size/hash,
and event type metadata remain. Each database sweep appends a content-free
`transcript_retention_sweep` activity record.

## Verification

Success output must show:

- the exact cutoff and seven-day policy;
- zero failures;
- counts and bytes for deleted raw stores;
- active, held, and ambiguous exclusions;
- a permissions rollback file.

Re-run the dry-run after apply. Successfully scrubbed runs are no longer
eligible; any remaining eligible run indicates retained content or a partial
operation and must be investigated before treating the sweep as complete.

## Rollback and recovery

Stop the timer before rollback:

```bash
systemctl --user disable --now paperclip-transcript-retention.timer
```

Permission changes are reversible:

```bash
pnpm transcripts:retention -- --restore-permissions \
  ~/.paperclip/instances/default/data/retention/permissions-rollback-<timestamp>.json
```

Restore only the recorded modes. Do not broadly change files back to
`0644/0755`.

Deletion of primary transcript content is intentionally irreversible. A
database disaster restore may reintroduce transcript-derived database fields
from the restricted 30-day backup window. Keep the restored service isolated
and owner-only, then run `pnpm transcripts:retention -- --apply` before normal
service access resumes. Database backups do not restore deleted Paperclip raw
logs or Cursor transcript files.
