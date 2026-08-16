# TSMC-20805 recovery report

Checked: 2026-08-13 Europe/Dublin

## Recovery finding

The purportedly absent preserved TSMC-20767 diff is recoverable as the existing
commit `17798f0a83e68fee0ea6380d45f282475dcac529`
(`feat(costs): add token outcome ledger export`). Its source worktree is clean
at that exact commit:

`/private/var/folders/_d/wj54v8k12s11fy0fh8gfh3y80000gn/T/paperclip-platform-worktrees/TSMC-20767-implement-token-outcome-ledger-and-deterministic-run-attribution-tsmc-20757`

The commit has the then-current `origin/master` tip `fef3a47b82e45ae6b308e5ef4eac55c8fe7e49cf`
as an ancestor, but is not itself an ancestor of that tip. The surviving
implementation changes eight files, including the costs service, route,
OpenAPI contract, shared cost types, UI client, and focused costs-service
coverage (360 insertions, 3 deletions).

## Verification and limits

- `git status --short` in the source worktree: clean.
- `git diff-tree --name-status -r 17798f0a8`: confirms all eight implementation
  files are present in the commit.
- `git merge-base --is-ancestor fef3a47b... 17798f0a8...`: passed.
- Focused test attempt: `pnpm exec vitest run server/src/__tests__/costs-service.test.ts`
  in the source worktree could not start because this execution sandbox may not
  write Vitest's generated `vitest.config.ts.timestamp-*.mjs` beside that other
  worktree (`EPERM`). No dependency installation or repair was attempted.
- Paperclip bridge request to its injected base URL failed with `curl: (7)` to
  `127.0.0.1:3100`; consequently this report cannot be uploaded or its issue
  status recorded during this run.

## Next action

CTO-Codex should review/cherry-pick or otherwise promote commit `17798f0a8`
onto the intended integration branch, then run the focused costs-service test
in a writable workspace. Restore the Paperclip bridge before recording the
issue disposition and uploading this report.

## Process consulted

- `TSKB0362` — port drift and served-tree/worktree safety.
- `TSKB0058` — durable custody and non-destructive recovery.
