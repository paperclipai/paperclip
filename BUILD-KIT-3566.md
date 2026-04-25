# BUILD for KIT-3566

## PR
https://github.com/paperclipai/paperclip/pull/4502

## Commits
- `124c6ae6` — feat(KIT-3566): add auth and rate limiting to knowledge /search and /research routes

## Files changed
- `server/src/routes/knowledge.ts` (+L47/-L3)

## Compile / Typecheck
```
$ cd server && npx tsc --noEmit
(no output = success)
```

## Local tests
```
NOTE: Local tests are NOT proof. See CI below.
No existing tests for knowledge routes auth in this PR scope.
```

## CI (REQUIRED — this is the actual proof)
- Commit state: `success`
- Snyk security scan: `12 security tests have passed` (security/snyk)
- GitHub Actions: No run triggered yet (PR workflow may need manual trigger or depends on branch configuration)

## Deviations from SPEC
- None identified.

## Remaining Risks
- Rate limiter is in-memory (per-process). In multi-process deployments, each process has its own limiter. This is consistent with the embed.ts pattern already in the codebase.
- Auth uses `assertAuthenticated` which validates `req.actor.type !== "none"`. This requires the Express middleware to properly set `req.actor`. If the middleware is misconfigured, auth would fail open (unauthenticated).

## Verification Artifacts
- PR: https://github.com/paperclipai/paperclip/pull/4502
- Commit: `124c6ae65ec153a4d58e46b582cf00ea231284a9`
