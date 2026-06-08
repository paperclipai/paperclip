---
name: paperclip-evidence-before-in-review
required: true
description: >
  Before moving any paperclip issue to `in_review`, produce the evidence
  shapes the server-side artifact-evidence gate expects, keyed by the
  issue's labels. Triggers on any PATCH that transitions status to
  `in_review`. Without the right evidence, the gate records a `block`
  verdict (Phase 1 warn-only today; Phase 2 will 422). Use whenever you
  are about to claim "done" or move an issue from `in_progress` to
  `in_review`.
---

# Evidence Before in_review

## Why

The paperclip `in_review` gate exists because agents historically claimed completion 4-5 times per issue with no real artifact verification — operators had to manually catch over-claiming each cycle. BLO-3979 spent ~5 reject cycles + ~30 runs over 2 days for exactly this reason. The gate (BLO-4461) verifies you attached **observable evidence** matching the issue's class.

This is a SHAPE check, not a TRUTH check. The gate only confirms you pasted the receipt. QA Engineer re-runs the receipt against the live artifact to catch fakery. Both lines of defense matter.

## Procedure

### 1. Read the issue's labels

```
paperclipGetIssue(issueId)
```

Look at the `labels` array. The label name(s) tell you which evidence shapes the gate requires.

### 2. Look up required shapes

| Label | Required shapes |
|---|---|
| `frontend`, `ui`, `cms-published` | `screenshot:1440x900` + `screenshot:390x844` + `checklist:done-when` |
| `backend` | `test-output` + `checklist:done-when` |
| `infra` | `kubectl-state` + `probe-output` |
| `cms-data-op` | `url-probe` |
| `db-migration`, `migration` | `migration-output` |
| `pr` | `pr-link` |
| (no label or unrecognized) | `checklist:done-when` (weak default — verdict will be `warn`, not `block`) |

Multiple labels union their required sets. A `frontend + pr` issue needs all of `screenshot:1440x900`, `screenshot:390x844`, `checklist:done-when`, `pr-link`.

Source of truth: `server/src/services/evidence-shapes.ts` (`DEFAULT_EVIDENCE_REGISTRY`).

### 3. Produce each required shape

#### `screenshot:1440x900` and `screenshot:390x844`

**For published-URL work**, take Playwright screenshots at exactly these viewports against the production URL. Not the Designer canvas. Not the bot's 1280x720. **The exact viewport string must appear in the filename, alt-text, OR work-product metadata.**

```ts
await page.setViewportSize({ width: 1440, height: 900 });
await page.goto("https://www.blockcast.network/<your-url>");
await page.screenshot({ path: "blog_entry_desktop_1440x900.png", fullPage: true });

await page.setViewportSize({ width: 390, height: 844 });
await page.screenshot({ path: "blog_entry_mobile_390x844.png", fullPage: true });
```

Then attach inline in your `in_review` comment using markdown image syntax:

```markdown
![desktop 1440x900](./blog_entry_desktop_1440x900.png)
![mobile 390x844](./blog_entry_mobile_390x844.png)
```

**Common mistakes the gate detects:**
- Bot screenshots at 1280x720 — doesn't match either required viewport.
- Designer canvas snapshots instead of published-URL — different DOM.
- Filename without the viewport string (e.g. `screenshot1.png`) — gate can't tell which viewport it is.

#### `checklist:done-when`

Map each bullet in the issue description's `## Done when` section to a row in a markdown table with a status marker. Number of rows must be ≥ number of bullets.

```markdown
| Criterion | Status | Evidence |
|---|---|---|
| entry page renders | ✅ | screenshot above + `curl https://www.blockcast.network/blog/...` returned 200 |
| listing page renders | ✅ | screenshot above |
| footer at bottom | ✅ | DOM probe in this comment showing footer.y > article.y + article.height |
```

Accepted status markers: ✅ ✓ ✔ ❌ ✗ ⏸ ⏹ ⚠️ `[x]` `[X]` `[ ]` and the bare words `pass` / `fail`.

**Pin every row to specific evidence** — a filename, a URL, a line of DOM-probe output. "✅ done" with no pointer doesn't help QA Engineer's re-verify.

#### `test-output`

Paste the actual test runner banner. Not a paraphrase.

```
 ✓ src/__tests__/foo.test.ts (12 tests) 23ms

 Test Files  1 passed (1)
      Tests  12 passed (12)
```

Accepted formats: vitest (`Test Files N passed`), pytest (`N passed in Ns`), jest (`Tests: N passed`), mocha (`N tests passing`).

**Common mistakes:**
- "All tests pass" with no banner — gate won't detect this.
- A failing run with `0 failed, 12 passed` — gate counts the `12 passed` so it satisfies the shape, but operator review will reject anyway.

#### `kubectl-state`

Paste a `kubectl get` output. Pod listing, service listing, or `kubectl rollout status` success line all work.

```
NAME                       READY   STATUS    RESTARTS   AGE
paperclip-0                1/1     Running   0          5m
```

#### `probe-output`

A `curl`/`wget`/`http` invocation followed within ~500 chars by an HTTP status line, a JSON body, or HTML.

```
$ curl http://paperclip.paperclip.svc:3100/api/ccrotate/status
HTTP/1.1 200 OK
{"updatedAt":"2026-05-11T...","accounts":[...]}
```

#### `url-probe`

A `curl https://…` invocation. Lighter than `probe-output` — used for `cms-data-op` issues where the goal is just to confirm a field landed.

```
$ curl https://www.blockcast.network/blog/making-traffic-federation-easier | grep -c 'blog-lede'
1
```

#### `migration-output`

Paste **observable output** from the migration run — not a prose claim. Any one of the following satisfies the shape:

**Migration runner banner** (drizzle-kit, Flyway, Liquibase, Alembic, or similar):
```
$ npx drizzle-kit push
[✓] Applied 1 migration
```
```
Flyway Community Edition 10.x
Database: jdbc:postgresql://...
Successfully applied 1 migration (execution time 00:00.123s)
```
```
INFO  [alembic.runtime.migration] Running upgrade abc123 -> def456, add_users_table
```

**psql result after running the migration SQL**:
```sql
ALTER TABLE
(1 row)
```
The `(N rows)` or `(N row)` psql suffix triggers the detector.

**EXPLAIN ANALYZE output** (for migration correctness checks):
```
Seq Scan on users  (cost=0.00..42.00 rows=1000 width=64)
```

**Inline DDL in a fenced code block**:
```sql
ALTER TABLE users ADD COLUMN email TEXT NOT NULL DEFAULT '';
CREATE UNIQUE INDEX users_email_idx ON users(email);
```

**Common mistakes:**
- "Migration applied successfully" prose with no runner output — gate can't detect this.
- A screenshot of a migration tool's UI — gate scans comment text, not images.
- Posting migration output in the issue description rather than a comment — gate only scans agent-authored comments.

#### `pr-link`

A full GitHub PR URL: `https://github.com/Blockcast/paperclip/pull/N`. Not "see PR" or "PR opened".

### 4. Only THEN transition to in_review

After all required shapes are in your closing comment, PATCH the issue:

```
paperclipUpdateIssue(issueId, { status: "in_review" })
```

The gate runs synchronously and writes its verdict to `issues.last_evidence_verdict`. Operator + QA Engineer see the verdict via the UI badge. If your evidence shape was complete, verdict is `pass`. If it wasn't, verdict is `block` (Phase 1: telemetry only; Phase 2: 422).

## Anti-patterns

These have all happened on real issues and the gate exists to catch them:

1. **"Trust me, it works."** No evidence. Block.
2. **Screenshots at the wrong viewport.** Bot's 1280x720, Designer's canvas size, or arbitrary heights. Gate matches the exact filename/metadata viewport string.
3. **Checklist without per-row evidence pointers.** Counts as `checklist:done-when` satisfied, but operator + QA will reject on review. Save the cycle by including pointers.
4. **DOM probes in agent-workspace files instead of inline.** The gate only scans comment bodies + work_products. Files in your shared workspace don't count.
5. **Operator pasting the receipt for you.** The gate ignores `authorUserId` comments — only `authorAgentId` comments produce evidence. Paste your own.
6. **Editing the issue description to remove `## Done when` bullets** to bypass the checklist requirement. Currently a Phase-1 bypass (see BLO-4828 punch list); will be detected in Phase 2.

## After landing

- If verdict is `pass`: operator + QA can review.
- If verdict is `block` (or `warn` for unlabeled): re-read your `in_review` comment. The `missing` array on the verdict points you exactly at what's missing. Add the evidence. Comment again. The gate re-evaluates on every PATCH to in_review.

## Reference

- Pure evaluator: `server/src/services/evidence-gate.ts`
- Label registry: `server/src/services/evidence-shapes.ts`
- Wiring: `server/src/services/evidence-gate-wiring.ts`
- Schema: `issues.last_evidence_verdict` (jsonb, nullable)
- Tracking: BLO-4461 (parent), BLO-4829 (evaluator), BLO-4824 (wiring), BLO-4828 (Phase-2 enforce)
