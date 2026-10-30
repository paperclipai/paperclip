# Resume readiness regression

An issue update can replace `blockedByIssueIds` and request `status: "todo"`
with `resume: true` and a comment in one PATCH. Resume checks use the supplied
list when present. An empty list removes all blockers. Requested blockers with
status `done` or `cancelled` do not prevent resume. When the field is absent,
the existing stored-dependency readiness policy applies.

Dependency writes still validate company membership and blocking cycles.
Checkout uses its existing persisted-dependency and ownership checks.

The installed-release regression uses a disposable PostgreSQL database and the
selected installation's real HTTP router, auth middleware, services and schema.
It does not connect to an existing database or start an agent.

```sh
PAPERCLIP_BACKPORT_INSTALL=/absolute/install node --test scripts/backports/resume-readiness.test.mjs
pnpm exec vitest run server/src/__tests__/issue-comment-reopen-routes.test.ts
```

The installed-release test covers replacement with an empty list, replacement
with terminal blockers, omitted and unresolved blocker lists, persisted
dependency rejection at checkout, and checkout ownership conflicts.
