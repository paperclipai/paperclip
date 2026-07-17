# release-probes — content-verify probe registry (NEO-527 / 522b)

Each `release-probes/<ISSUE>.yaml` is a set of **content probes** that assert an issue's work is
actually live on the running instance — by **behaviour**, never by commit lineage. On cortex-beta,
branches re-land the same work under fresh SHAs (ports, renumbered migrations), so a SHA-ancestry
check proves nothing. A content probe asserts the marker is in the served bundle, the route is
mounted, the table exists.

The runner is [`scripts/verify-content.mjs`](../scripts/verify-content.mjs). It loads one or more
probe files, runs every probe against a target base URL, prints a per-probe PASS/FAIL report, and
exits non-zero if any probe is red. It is wired as the **post-deploy gate** in
[`scripts/cortex-deploy.sh`](../scripts/cortex-deploy.sh): after the health gate passes, the whole
registry runs against the running instance; **red → auto-rollback** to last-known-good + restart +
re-verify + alert.

## Running it

```sh
# one issue's probes
node scripts/verify-content.mjs --base http://127.0.0.1:3200 release-probes/NEO-521.yaml

# the whole registry (what the deploy gate does)
PAPERCLIP_CONFIG=/home/ubuntu/.paperclip/instances/beta/config.json \
  node scripts/verify-content.mjs --base http://127.0.0.1:3200 --dir release-probes
```

Exit: `0` all green · `1` one or more red (drives rollback) · `2` usage/config error
(unreadable/invalid probe file, empty registry when explicitly targeted).

## File schema

```yaml
issue: NEO-521                      # optional; defaults to the filename stem
description: one-line what this set proves   # optional
probes:                            # required, non-empty
  - name: <probe name>             # shown in the report
    type: bundle | route | db      # required
    # ...type-specific fields below
```

### `bundle` — assert a marker is in the served JS

Fetches the SPA's `index.html` (default `path: /`), auto-discovers the hashed `index-*.js` asset,
fetches it, and asserts `match` is present. Auto-discovery means the probe survives every rebuild
(the bundle hash changes each build).

| field        | req | meaning                                                              |
|--------------|-----|----------------------------------------------------------------------|
| `match`      | ✓   | regex the asset body must contain (e.g. `brand-kits`)                |
| `path`       |     | HTML doc to discover the asset from (default `/`)                    |
| `assetMatch` |     | substring to pick among referenced `.js` assets (default `index-`)  |
| `asset`      |     | fetch this exact asset path instead of auto-discovering             |

```yaml
- name: brand-kit-in-bundle
  type: bundle
  path: /
  match: brand-kits
```

### `route` — assert an API route is mounted / returns an expected shape

`curl`s `base + path` and asserts the HTTP status. A `404` where `200`/`401` was expected means the
feature never deployed. Optionally assert a body marker.

| field          | req | meaning                                                            |
|----------------|-----|--------------------------------------------------------------------|
| `path`         | ✓   | route path (e.g. `/api/companies/<uuid>/brand-kits`)              |
| `expectStatus` |     | status or list of accepted statuses (default `[200]`)             |
| `match`        |     | regex the response body must contain                              |

```yaml
- name: brand-kits-route-mounted
  type: route
  path: /api/companies/00000000-0000-0000-0000-000000000000/brand-kits
  expectStatus: [200, 401]   # mounted & auth-gated; 404 = red
```

### `db` — assert a migration / table / column / seed row

Runs `command` and asserts `match` in its output. **Hard Rule #1:** DB assertions go through the
runtime/CLI, never a raw client — the runner **refuses any command containing `psql`**. Use
[`scripts/db-assert.mjs`](../scripts/db-assert.mjs), which queries through the app's Drizzle client
(`@paperclipai/db`) against the same DB the running instance uses (`PAPERCLIP_CONFIG`).

| field             | req | meaning                                                         |
|-------------------|-----|-----------------------------------------------------------------|
| `command`         | ✓   | shell command to run (must not invoke `psql`)                   |
| `match`           | ✓   | regex the command's stdout/stderr must contain                  |
| `allowNonZeroExit`|     | accept a non-zero command exit (default: non-zero exit = red)   |

```yaml
- name: brand-kits-table-present
  type: db
  command: node scripts/db-assert.mjs --regclass public.brand_kits
  match: "db-assert: OK"
```

`db-assert.mjs` assertions: `--regclass <schema.table>`, `--column <table.column>`,
`--sql <query> --expect-nonempty`.

## Adding probes for a new issue

Drop a `release-probes/<ISSUE>.yaml` alongside the PR that lands the work — it becomes a normal PR
deliverable (documented in 522e). Every deploy re-runs the whole registry, so probe files
accumulate into a growing content-level regression suite for beta.

## `done ⇒ on-beta` reconciliation (NEO-528 / 522c)

[`scripts/reconcile-beta.mjs`](../scripts/reconcile-beta.mjs) is the scheduled drift guard — the
check that would have caught Brand Kit (NEO-138). It walks every issue in `done` (Paperclip API)
and, **reusing this same registry + `verify-content.mjs` runner** (it does not build a second probe
engine — it invokes `verify-content.mjs --json` per issue), classifies each:

- **live** — a `release-probes/<ISSUE>.yaml` exists and all its probes pass on the running beta.
- **drift** — a probe file exists but a probe is red → *closed but not actually deployed*. The
  offending issue gets an idempotent flag comment, and it appears in the CTO digest.
- **unverifiable** — no probe file, so content can't be confirmed. Surfaced in the digest (never a
  silent false green), never per-issue-spammed by default.

It posts one **CTO digest** to a target issue (`--digest-issue`, the routine's run issue),
@-mentioning the CTO only when there is drift to act on. Exit: `0` no drift · `1` drift · `2`
config error. It runs on a **Paperclip routine** (schedule trigger) assigned to Gene, so a fresh
run JWT is available to post — see the routine `beta done⇒on-beta reconciliation (522c)`.

```sh
PAPERCLIP_CONFIG=/home/ubuntu/.paperclip/instances/beta/config.json \
  node scripts/reconcile-beta.mjs --base http://127.0.0.1:3200 \
  --digest-issue <run-issue-id> --cto-agent <werner-agent-id>
# add --dry-run to compute + print the digest without posting anything
```
