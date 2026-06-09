# ValAdrien OS — Monitoring & Debug Runbook

**Audience:** Sol (founding engineer agent) and the eng-overseer auditor. This is the
go-to doc for "the OS is misbehaving — what do I check, what's a known issue, what's
the fix?" Keep it current: when a new error class is hit, add it to the **Error
Catalog** with symptom → root cause → fix → status.

Last major update: 2026-06-09.

---

## 1. Architecture: where everything runs (read first)

A bug's *location* is usually the fastest clue. Three planes, ONE database:

| Plane | What | Runs | Can it execute agents? |
|---|---|---|---|
| **Control plane** | API + SPA | **Vercel** serverless (`valadrien-os-server`, region `pdx1`), entry `api/index.mjs` → `server/dist` | **NO** — read-only FS, no Claude CLI |
| **Runtime / worker** | Agent execution + heartbeat scheduler | **Railway** project `management-os`, service `valadrien_staff` (always-on), `HOME=/valadrien-os` | **YES** — this is the only place agents run |
| **Database** | Postgres (all data) | **Supabase** Pro, project ref `nzbwmlvxnzfhqaznyggw`, region `aws-1 us-west-2` | — |
| **Object storage** | Uploads (logos/assets) | **Supabase Storage** (S3-compatible), bucket `valadrien-os-assets` (private) | — |

**Connection routing (critical):**
- Vercel → Supabase **transaction pooler `:6543`** (multiplexes, ~200+ client cap on Pro). `prepare:false`. Serverless pool `max:3`, `idle_timeout:10s`, `statement_timeout:8s`.
- Railway worker → Supabase **session pooler `:5432`** (stable, 15-client cap). Pool `max:10`.
- **Tell from a path/host which plane failed:** `/home/vercel` = ran on Vercel; `aws-1-...pooler.supabase.com:5432` = worker's DB; `:6543` = Vercel's DB.

**Deploy model:**
- **Vercel = push-to-deploy.** A push to `rebrand/valadrien-os` builds production and auto-aliases `os.valadrien.dev`. NO `vercel promote`. Production Branch is set to `rebrand/valadrien-os` in Vercel → Settings → Environments → Production.
- **Railway = manual** (`railway up` from repo root, or it picks up its own builds). A git push does **NOT** redeploy Railway. Most control-plane fixes don't need a Railway redeploy.

---

## 2. Quick monitoring / triage commands

```bash
# Health (the single best signal). Warm shape proves DB query works; storage shows the provider.
curl -s https://os.valadrien.dev/api/health | python3 -m json.tool
#   { status:ok, deploymentMode:authenticated, bootstrapStatus:ready,   <- DB OK
#     storage:{provider:"s3",persistent:true} }                          <- uploads OK
#   "booting":true            -> cold instance answering mid-boot (fine)
#   503 database_unreachable  -> DB/pooler problem (EMAXCONN?) — see Catalog
#   timeout/000               -> cold-boot hang (see Catalog)

# Storage backend live?
curl -s https://os.valadrien.dev/api/health | grep -o '"storage":[^}]*}'

# Cold-boot probe (catch hangs): hit health repeatedly, watch for 000/40s timeouts
for i in $(seq 1 8); do curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" \
  --max-time 20 "https://os.valadrien.dev/api/health?cb=$RANDOM-$i"; sleep 6; done

# Railway worker status + logs (agent execution lives here)
export RAILWAY_TOKEN=$(cat ~/.config/valadrien/railway-token)
railway status                              # service Online? deployment ID?
railway logs --service valadrien_staff      # look for: resumeQueuedRuns, claimQueuedRun,
                                            #   executeRun, CONNECT_TIMEOUT, backups
```

**Vercel runtime logs** — via the Vercel MCP `get_runtime_logs` (project
`prj_GQOzJ3SG1yje5ze67ILqM35qHpdx`, team `team_HxifZfm9qyYJXqg21ZR8V4yo`). Useful
filters: `statusCode:"504"`, `level:["error"]`, `query:"EMAXCONN"`, `query:"home/vercel"`.
Note: it **truncates** message bodies/paths — good for status/clustering, not full payloads.

---

## 3. Error Catalog (symptom → root cause → fix → status)

> Format: each entry is something we actually hit. ✅ DONE = shipped+verified. ⚠️ OPEN = watch / not fully fixed.

### ✅ Cold-boot hang — OS "stuck loading", `/api/health` times out 10–300s
- **Symptom:** after idle, the OS sits on a loading splash; health probes hang/504 in clusters.
- **Root cause (layered):** the Vercel function did unbounded I/O at cold boot, and `api/index.mjs` awaited *all* of `startServer()` before serving any request (so even `/api/health` waited). The dominant cost was the **module-import phase**: `@zed-industries/codex-acp` (~165MB) was eval'd at module scope via the eager adapter registry → `acpx-local/server` → `execute.ts` `import "acpx/runtime"`.
- **Fix:** (a) bound startup DB ops + skip backfill/migrations on Vercel (`1e854ad4`); (b) `statement_timeout:8s` on the serverless pool (`packages/db/src/client.ts`); (c) run boot in the background + answer `/api/health` immediately while booting (`api/index.mjs`); (d) **lazy-load `acpx/runtime`/codex-acp** in `acpx-local/src/server/execute.ts` (memoized dynamic `import()`; types stay `import type`) so it's never in the Vercel cold path (`55032d76`). Verified: health fast, no 40s hangs.
- **Watch:** other adapters' `/server` execute paths shouldn't statically import heavy deps — keep them lazy.

### ✅ List pages (Issues/Workspaces) stuck in skeleton → `504 Gateway timeout`
- **Symptom:** page shell + header load, but Issues/Workspaces lists hang then 504.
- **Root cause:** these pages fan out 6+ parallel company-scoped queries; the serverless pool was `max:1`, so they serialized AND had zero redundancy — any `:6543` drop/stale connection wedged the whole instance.
- **Fix:** serverless pool `max:1 → 3` (`packages/db/src/client.ts`, `3fec4116`). Monitored rollout: 0 `EMAXCONN`, 0 504s after.
- **⚠️ Revert lever:** `max:1` originally existed to avoid `EMAXCONN` (pooler cap → `database_unreachable` OUTAGE). If `EMAXCONN`/`database_unreachable` recurs (esp. under deploy churn or traffic growth), drop `max` back to 1. Deeper fix: coalesce the per-page query fan-out server-side.

### ✅ Logo / image upload fails (`Request failed: 504`, then couldn't persist)
- **Symptom:** company-settings logo upload errors; even when not 504, the image wouldn't stick.
- **Root cause:** two stacked — (1) the 504 was the cold-boot hang; (2) storage was `local_disk` (the default) which can't persist on Vercel's ephemeral/read-only FS.
- **Fix:** migrated to **Supabase Storage via the existing `s3` provider** (no code change). Env on Vercel Production: `VALADRIEN_OS_STORAGE_PROVIDER=s3`, `…_S3_BUCKET=valadrien-os-assets`, `…_S3_REGION`, `…_S3_ENDPOINT=https://nzbwmlvxnzfhqaznyggw.storage.supabase.co/storage/v1/s3`, `…_S3_FORCE_PATH_STYLE=true`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` (= Supabase Storage S3 access keys). Bucket is **private** (the OS streams assets through its own server via `/assets/:id/content`). Verified: `POST …/logo → 201`, `GET …/content → 200`.
- **Gotcha:** Vercel env only applies to deployments built **after** the env is saved — redeploy after changing it. Confirm with the storage field in `/api/health`.

### ✅ `/auth` 401/403 retry storm + authed calls on the unauth page
- **Root cause:** React Query's default 3-retry fired boot-time authed queries 4× on `/auth`; adapters/companies queries fired before auth was known.
- **Fix:** global retry predicate (never retry 400/401/403/404/405/409/422; bound transient to 2) in `ui/src/main.tsx`; `useAuthedDataEnabled()` gate on the adapter + company-list queries; CloudAccessGate doesn't bounce to `/auth` on a *transient* (thrown) get-session, only a real 401.

### ✅ On-demand "Run Heartbeat" fails `EACCES: mkdir '/home/vercel'` (adapter_failed)
- **Symptom:** clicking Run Heartbeat (Ti Claude / Sol) fails instantly (0s) with `EACCES … /home/vercel`.
- **Root cause:** `heartbeat.ts` had **no control-plane/runtime gating** — `enqueueWakeup` created the run AND executed it **inline** (`startNextQueuedRunForAgent → executeRun`). Called from the Vercel API, it tried to run the Claude CLI on Vercel → `/home/vercel` is Vercel's HOME, read-only → fail. (Scheduled/timer heartbeats worked because the Railway scheduler executes those.)
- **Fix:** gate `startNextQueuedRunForAgent` to no-op when `process.env.VERCEL` is set (`a30ebaaf`). Runs are created `status:"queued"`, so Vercel now just enqueues; the Railway worker drains via its periodic `resumeQueuedRuns()` tick (~30s) and executes with `HOME=/valadrien-os`. Railway unchanged.
- **VERIFIED 2026-06-09:** post-fix, on-demand runs queue on Vercel → the Railway worker drains + executes them → **Ti Claude AND Sol both reached `succeeded`** (Railway working dir `/valadrien-os/...`, `claude_local`). No more `/home/vercel`. Worker confirmed `● Online` + scheduler ticking.
- **Depends on:** the Railway worker being **Online** + scheduler ticking. If an on-demand run sits **`queued` forever** (instead of failing), the worker is down or not draining → `railway logs --service valadrien_staff`.
- **Not an error:** a run whose **issue is `blocked`** is correctly cancelled with `issue_dependencies_blocked` ("ValadrienOs will wake the assignee when blockers resolve"). To make the agent actually DO that work, unblock/clear the issue's blockers — the agent re-wakes automatically.
- **Auto-unblock (shipped `e66e9416`):** when an issue becomes terminal (done/cancelled) via `issuesService.update`, any issue it blocked whose unresolved-blocker count is now 0 is auto-flipped `blocked → todo` so the worker picks it up — the dependency chain is now self-driving (no manual flip). **Coverage edge:** this fires on `svc.update` (agent-completes-via-API → Vercel, the common path). The worker's own **direct-`tx.update` cancellations** (heartbeat reconcile paths) bypass `svc.update`, so a blocker *cancelled by the worker in-process* won't trigger the cascade — rare; route those through `svc.update` or add a periodic reconcile if it ever matters.

### ✅ GLASSHOUSE color-token test failures (pre-existing, design lane)
- Tests asserted raw Tailwind colors (`text-emerald`, `border-amber-600`) after the design sweep tokenized components to `status-*`. Fixed by updating assertions (design session) + `vitest.setup.ts` `matchMedia` polyfill + stale `NavLink` mock fix. Not product bugs.

### ⚠️ Worker DB `CONNECT_TIMEOUT` to `:5432` (session pooler) — INTERMITTENT, OPEN
- **Symptom:** worker logs `write CONNECT_TIMEOUT aws-1-us-west-2.pooler.supabase.com:5432`.
- **Likely cause:** the `:5432` session pooler has a **15-client cap**; if the worker's pool (`max:10`) + other clients fill it, new connects time out. Mostly transient (backups + heartbeat recovery still succeed around it).
- **Not yet done:** confirm whether to lower the worker pool `max`, or move the worker to a higher-cap pooler. Watch frequency; if it correlates with failed runs, prioritize.

### ⚠️ Runs cancelled as "blocked" (`claimQueuedRun: cancelled blocked queued run`)
- A claimed run was cancelled because its issue had an unresolved blocker (`unresolvedBlockerCount:1`). Expected behavior for blocked issue-runs — but verify it's not silently dropping work the user expects to run. On-demand heartbeats with no issue context should not be affected.

---

## 4. Open items / "not done" (carry forward)

- **`codex-acp` lazy-load is acpx-local only.** Live agents use `claude_local` (different adapter). If other adapters' execute paths get heavy static imports, they'll re-introduce cold-boot weight — keep execute imports lazy.
- **Per-page query fan-out** (Issues/Workspaces fire 6+ parallel queries) leans on pool `max:3`. Durable fix = server-side batching/coalescing so reliability doesn't depend on pool size.
- **Worker `:5432` CONNECT_TIMEOUT** — root-cause + size the pool (above).
- **Route-split `App.tsx`** (≈53 eager pages, large index chunk) + lazy the editor — first-paint/parse win, not yet done.
- **`get-session` still fires on `/auth`** (1× 401) — necessary auth probe; can't be zero.

---

## 5. Revert levers (fast rollbacks)

| Change | Revert |
|---|---|
| Serverless pool `max:3` (`3fec4116`) | set `max` back to `1` in `packages/db/src/client.ts`, push |
| `statement_timeout:8s` | remove the `connection:{...}` block in client.ts, push |
| Any Vercel change | `git revert <sha>` + push (push-to-deploy) |
| Storage env wrong | fix env on Vercel Production + redeploy |

**Golden rule:** on a live OS, prefer a one-line reversible change + monitored rollout
(watch `/api/health` + `EMAXCONN`) over a big refactor. `EMAXCONN`/`database_unreachable`
is an OUTAGE — treat any pool/connection change as high-stakes.
