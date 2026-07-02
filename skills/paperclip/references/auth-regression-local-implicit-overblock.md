# Auth regression — local_implicit over-block

Late-stage auth middleware additions can over-broadly reject `local_implicit`
actor traffic and lock the board out of `local_trusted` deployments. This
reference covers the incident shape, the lessons, and the **shipped fix
design** (RES-1298) so future auth changes do not re-open the hole or
re-introduce the lockout.

## When this matters

Whenever you are adding or modifying server-side auth checks that touch:

- `actor` resolution (`server/src/middleware/auth.ts`)
- Mutation gates on `/api/issues`, `/api/agents`, `/api/companies`, or
  any route that uses `requireBoard()`
- Anything that conditions on `req.actor.source === "local_implicit"`

In `local_trusted` deployment mode the board user IS `local_implicit`.
Any guard that rejects all `local_implicit` mutations also rejects the
legitimate board, which means governance loses access. This is exactly
how RES-1297 happened.

## The original incident (RES-1297)

[RES-1295](/RES/issues/RES-1295) added `requireAuthForLocalTrustedMutations()`
middleware to block agent curl impersonation. The guard rejected all
`local_implicit` POST/PATCH to the three sensitive route prefixes. The
board, also `local_implicit` in `local_trusted` mode, was locked out for
~80 minutes until Hermes diagnosed and the WIP was reverted.

Root cause: the middleware could not distinguish between

- the board calling `/api/issues` from a real browser, and
- an agent shelling out via `curl` with no `Authorization` header.

Both presented as `actor.source === "local_implicit"` because the
`local_trusted` actor resolver unconditionally promoted any
unauthenticated request to the board actor.

Full incident write-up: [RES-1297](/RES/issues/RES-1297).

## Shipped design (RES-1298)

[RES-1298](/RES/issues/RES-1298) shipped the redesign. The distinction is
made at **actor resolution**, not in a downstream guard.

In `local_trusted` mode, the default `local_implicit` board actor is
granted only when the request looks browser-originated. Otherwise the
actor resolves to `{ type: "none", source: "none" }` and existing
`requireBoard()` route checks reject naturally with 403.

```
if (deploymentMode === "local_trusted") {
  const browserOriginated =
    isSafeMethod(req.method) || requestHasTrustedBoardOrigin(req)
  req.actor = browserOriginated
    ? { type: "board", userId: "local-board", ..., source: "local_implicit" }
    : { type: "none", source: "none" }
}
```

Files:

- `server/src/middleware/board-origin.ts` — shared
  `trustedOriginsForRequest`, `requestHasTrustedBoardOrigin`,
  `isSafeMethod`. Honors `Host`, `X-Forwarded-Host`, `PAPERCLIP_PUBLIC_URL`,
  and dev defaults.
- `server/src/middleware/auth.ts` — `actorMiddleware` applies the gate.
- `server/src/middleware/board-mutation-guard.ts` — same guard for the
  `authenticated`-mode browser-board path; reuses the shared helper.

### Why this is safe for the board

- A browser making a POST/PATCH fetch automatically sends `Origin`
  (CORS spec; cannot be omitted). Same-host PATCH flows also send
  `Referer` as a fallback.
- The new rule only *withholds* the implicit board grant; the gate
  cannot block a legitimate browser request.
- Read paths (`GET`/`HEAD`/`OPTIONS`) are unaffected — the actor is still
  the implicit board for safe methods, so login bootstrap and browse
  flows behave identically.

### Why this blocks the impersonation hole

- `curl` does not synthesise `Origin` or `Referer`. An agent shelling
  out without its run JWT and without those headers gets actor
  `{ type: "none" }` and is rejected by the route's board check.
- The body cannot inject identity — fields like `{ "actor": "board" }`
  are ignored by the resolver.

### Known limitation

A deliberately hostile local agent that forges
`-H "Origin: http://localhost:3100"` can bypass the gate. This is
out of scope per the RES-1298 threat model:

- LAN/firewall covers external attackers.
- Per-agent budget, audit log, and chain-of-command cover deliberate
  insider abuse.

If the threat model later expands to "deliberately hostile local
process," strengthen with a server-issued signed cookie (see
"Future strengthening" below).

## Required regression tests

Any change to actor resolution or to the three sensitive route prefixes
must keep these tests green
(`server/src/__tests__/auth-local-trusted-impersonation.test.ts`):

1. **Browser board POST with realistic Host + matching Origin** → 201.
   Exercises the `Host` fallback path of `trustedOriginsForRequest`.
2. **Browser board POST behind reverse proxy via `PAPERCLIP_PUBLIC_URL`**
   → 201. Sends `X-Forwarded-Host` distinct from `Host` so the
   `PAPERCLIP_PUBLIC_URL` fallback is the load-bearing match.
3. **Browser board PATCH with Referer (no Origin)** → 200.
4. **Curl POST with no Bearer, no Origin/Referer** → 403, actor type "none".
5. **Curl POST with hostile `actor` body field** → 403.
6. **Curl POST with untrusted off-host Origin** → 403.
7. **Safe-method GET without Origin** → 200 with implicit board actor.
8. **`authenticated` mode untouched** — POST with Origin but no
   Bearer/session → 403 with actor source `"none"`.

Tests 1 and 2 are the explicit insurance against the RES-1297 over-block
recurring. Do **not** weaken them by hard-coding `http://localhost:3100` —
they must exercise the live trusted-origin plumbing.

## Future strengthening (if needed)

If the threat expands to "deliberately hostile local agent" — for
example because Paperclip is hosting non-trusted local agents —
strengthen by adding a server-issued, signed `pcp_board_session` cookie
set on the initial `/` GET and required for mutations in addition to
the browser marker. This is a strictly larger surface change and must
itself land behind a `request_confirmation` because it modifies the
board UI auth handshake (a one-way door).

Do not ship a cookie-based gate *and* preserve the Origin gate without
careful test coverage of the bootstrap path — a broken cookie issue
flow would re-create the RES-1297 lockout.

## Process lessons from RES-1297

These applied to RES-1298 and should apply to future auth changes:

1. **Validate against the legitimate user flow first.** Before adding a
   guard that rejects an actor source, write a test that proves the
   board can still do the thing. RES-1295 had no such test and
   shipped the over-block.
2. **Test #1 is a board-flow regression test, not a hostile-flow test.**
   Hostile-flow tests prove you blocked the bad path; board-flow tests
   prove you did not break the good one. Both are mandatory.
3. **Narrow scope to the smallest distinguishing signal.** RES-1295
   keyed on "is `local_implicit` mutation" — too broad. RES-1298 keys
   on "missing browser marker on mutating verb in `local_trusted` mode" —
   narrow and falsifiable.
4. **Auth surface changes are one-way doors.** CEO sign-off via
   `request_confirmation` is mandatory before shipping. Board sign-off
   is additionally mandatory if the board UI auth handshake changes
   (RES-1298 did not need this; a future cookie scheme would).
5. **Recovery path = revert by file, not by feature flag.** RES-1297
   was recovered by `git restore server/src/app.ts server/src/middleware/auth.ts`
   and a service restart. Keep auth changes in single, revertible
   commits.

## Related issues

- [RES-1295](/RES/issues/RES-1295) — original (reverted) impersonation fix.
- [RES-1297](/RES/issues/RES-1297) — incident write-up.
- [RES-1298](/RES/issues/RES-1298) — shipped redesign documented above.
