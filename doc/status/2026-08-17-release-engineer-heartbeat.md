# Release Engineer Heartbeat — Aug 17, 2026 ~00:40 UTC

## Status: Deployment verified — CTO go/no-go requested (RC-3)

All blockers resolved (wake: `issue_blockers_resolved`). This run performed
fresh deployment verification, found and fixed a stale UI bundle, tagged RC-3,
notified the Support Engineer, and requested CTO sign-off.

## Key Finding: Deployed UI was stale (H-1 fix not actually live)

The staging UI bundle served before this run was built Aug 15 23:29 — BEFORE the
H-1 gate-query invalidation fix landed (commit b7d0261e3f, 23:47). The running
bundle still used the old 4-element gate query key:

```
n.invalidateQueries({queryKey:z.issues.planGates(e)})   // OLD, no detail refresh
```

**Fix applied:** rebuilt the UI from release branch HEAD (`pnpm --filter
@paperclipai/ui build`, 46.5s). New bundle (index-DxKxnjLC.js) verified to
contain the H-1 fix:

```
invalidateQueries({queryKey:["issues","plan-gates",e]})  // 3-element prefix
invalidateQueries({queryKey:z.issues.planDocument(e)})   // plan doc refresh
invalidateQueries({queryKey:z.issues.detail(e)})         // detail refresh (NEW)
```

Staging server serves the new bundle (`curl /plans` → index-DxKxnjLC.js).

## Deployment Verification (this run)

| Check | Result |
|-------|--------|
| /plans UI route | HTTP 200 — SPA shell served by server (port 3101) |
| H-1 fix in served bundle | PASS — 3-element prefix + detail invalidation present |
| Server code freshness | Process started 06:18 (tsx from source); includes H-2 (885a6740b3), M-1 N+1 batch fix (3ba7c5aa37), P2 fixes (f93399f976) |
| Plan document route | 401 auth-required (registered) — GET/POST /issues/:id/documents/plan |
| Plan revisions route | 401 auth-required (registered) — GET + diff GET |
| Plan gates routes | 401 auth-required (registered) — GET/POST/PATCH |
| Workstream C server code | NOT in running server (13:17 commit, separate BOARD-1 release) — out of scope for VOY-1264 |

## Release Steps

- H-1 (VOY-1268 Gate UI refresh) — DONE ✅ now actually deployed (bundle rebuilt)
- H-2 (VOY-1269 allApproved predicate) — DONE ✅ in server since process start
- M-1 (VOY-1273 / 3ba7c5aa37 N+1 batch fix) — DONE ✅ in server
- Tag release candidate — v0.4.0-alpha-rc.3 created + pushed to fork at faedd1486f
- Support Engineer notified — VOY-1303 created (docs sync verification for RC-3)
- CTO go/no-go — request_confirmation created (idempotencyKey
  release:voy-1264:cto-go-no-go:rc3, continuationPolicy wake_assignee)

## Handoff

- QA Engineer (VOY-1265) verifies in staging after CTO acceptance.
- Production remains a separate go/no-go gate.
