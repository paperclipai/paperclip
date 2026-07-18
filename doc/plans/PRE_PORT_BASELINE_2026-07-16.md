# Pre-Port Baseline

**Date:** 2026-07-16

---

## Repository

`C:\Users\mikeb\paperclip`

---

## Branch

`docs/paperclip-operational-audit-2026`

---

## HEAD Commit

`e6da760d15fbed89480b952dd74531460986a40e`

---

## Upstream Commit Verified

`6ec059ab4eb36faa3ad62c915095916c80829c1b`

---

## Runtime Status

| Runtime | Status |
|-----------|--------|
| Legacy fork runtime | **Archived** — embedded PostgreSQL fails to initialize; schema 30+ migrations stale |
| Current upstream | **Verified Operational** — tested in disposable worktree `paperclip-upstream-test` |

---

## Database

| Database | Status |
|----------|--------|
| Legacy `~/.paperclip/instances/default/db` | **Preserved read-only** — stopped, stale PID file renamed |
| Legacy backup | **Verified** — `default-backup-20260716-104332` |
| Clean upstream test | **Verified** — `~/.paperclip/instances/upstream-clean-test` created successfully |

---

## Verified Evidence

- [x] API healthy (`/api/health` returned 200, `status: ok`)
- [x] Embedded PostgreSQL operational (port 54329, new instance)
- [x] 172 migrations applied automatically on first run
- [x] Plugin scheduler operational
- [x] Automatic backups operational (60-minute interval, 7-day retention)
- [x] Server listening on `127.0.0.1:3100`
- [x] No process conflicts on ports 3100 or 3101

---

## Divergence Snapshot

| Direction | Commits |
|-----------|---------|
| Local `master` ahead of `upstream/master` | **44** |
| Local `master` behind `upstream/master` | **798** |
| Merge base | `1d9f7a5149fe60b66234d696f9ddc468e5afe19e` |

---

## Integration Starting Point

- No code ported.
- No merge performed.
- No rebase performed.
- No commits performed on integration branch.
- Legacy data untouched.

---

## Approval

Awaiting operator approval to create `feat/qsl-upstream-integration` from `upstream/master`.

---

*This baseline is a snapshot. It must not be modified after integration work begins. If the baseline facts change, create a new dated baseline document instead.*
