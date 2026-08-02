# Served-tree audit — TSMC-18905

Audited: 2026-08-02 (Europe/Dublin)

## Commit and ancestry

- Implemented commit: `08816818c2c25fe262e1280bd0720064f15c7043` — `Harden K18/K19 close evidence paths`.
- Served branch/head: `live` at `7439bc49747bb6fd3b3615c37bc195447c985f56`.
- `git merge-base --is-ancestor 08816818c HEAD` returned `0`; the K18/K19 commit is reachable from the served head.

## Live instance evidence

- `GET /api/health` returned `status: ok` from the local-trusted control plane.
- The running instance reported `sourceDir: /Users/glad0s/paperclip/server`, `branchName: live`, `fullSha: 7439bc49747bb6fd3b3615c37bc195447c985f56`, and `pid: 92764`.
- The server reports a dirty served tree (96 unstaged, 89 untracked files). This audit therefore proves deployment ancestry and the running served SHA, not byte-for-byte pristine checkout identity.

## Focused verification

Executed from `/Users/glad0s/paperclip`:

```sh
pnpm vitest run server/src/__tests__/adapter-policy-echo.test.ts \
  server/src/__tests__/issue-execution-policy-routes.test.ts \
  server/src/__tests__/issues-service.test.ts
```

Result: exit 0. The run emitted only existing warning-path diagnostics for missing/invalid test run-log metadata; no Vitest failure was reported.

## Scope caveat

Two files touched by the implementation commit have later uncommitted served-tree edits:

- `server/src/routes/issues.ts`: one unrelated nullable-title type adjustment.
- `server/src/__tests__/issues-service.test.ts`: 109 additional test lines.

The three focused suites were rerun on this running served-tree revision. No reopen is warranted: the committed implementation is an ancestor of the served head and the live health check is green.
