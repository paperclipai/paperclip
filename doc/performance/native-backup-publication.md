# Native backup publication benchmark

Retiring a native harness backup can involve many immutable directories and
small files. Cleanup repairs directory permissions before removing the retired
tree. Publication waits for cleanup, preserves the previous backup when lease
stamping fails, and emits its completion notification after cleanup succeeds.
Cleanup uses asynchronous filesystem operations so unrelated requests can
continue while it runs. Directory preparation is serial and does not follow
symlinks into live trees.

Run the focused correctness tests from an installed checkout:

```sh
pnpm --filter @paperclipai/server exec vitest run src/services/native-runtime/native-harness-backup-cleanup.test.ts src/services/native-runtime/native-harness-backup-publication.test.ts
```

Run the performance comparison from the repository root with the Node version
used by the target server. Use a quiet machine and an explicit baseline commit:

```sh
node server/scripts/benchmark-native-backup-publication.mjs \
  --baseline-ref 774ddc72713d6aa7cb516691c71f1fc23bcfa5ff \
  --output /tmp/native-backup-publication.json
```

The script compiles the real publication service and its dependencies for both
the baseline commit and the working tree. Each run uses a separate server
process. Fixture preparation occurs before measurement. The default fixture has
100 immutable directories with 100 small files in each of the `current` and
`previous` backups: 20,000 files to remove. Both backups also have a symlink to a
read-only live directory outside the retired trees. The new pending backup has
a distinct manifest. Every completed run checks the new manifest, complete
removal of retired and pending trees, and unchanged live contents and mode.

A separate process sends requests to a small loopback HTTP endpoint every five
milliseconds. Arrivals use a fixed clock and include overdue requests. The
report includes request completion and error counts, generator lateness, p95
and maximum foreground latency, requests served during publication, publication
wall time, process CPU time, and maximum event-loop delay. Three pairs alternate
baseline and treatment order. Change the fixture with `--pairs`, `--directories`,
`--files-per-directory`, or `--interval-ms`.

The result records Node/platform, baseline SHA, treatment HEAD and uncommitted
service diff. Compiled modules and source maps stay in the printed evidence
directory. Successful fixtures are removed; failed fixtures remain for diagnosis.

This is a service benchmark. The HTTP endpoint is a responsiveness probe, not
the assembled Paperclip API. The lease-stamp callback resolves without database
work. It does not prove a hosted latency or total-CPU improvement. Process CPU
during publication includes foreground requests that the synchronous baseline
cannot serve until cleanup completes. Async cleanup can consume more CPU while
keeping the event loop responsive. Qualify the affected run/checkpoint/recovery
journey and compare matched hosted windows before claiming deployed acceptance.
