# AGNB → Paperclip Consolidation Plan

**Goal:** Make Paperclip the single repo for landing + UI + API + worker + data. Phase out the standalone AGNB Next.js app.

**Status when written:** UI already ported (first-party React pages). Backend still 100% AGNB (236 Next.js routes + Supabase). DB decision: **consolidate Supabase `internal` schema into Paperclip's own Postgres.**

**Date:** 2026-06-02

---

## 0. EXECUTION STATUS (updated 2026-06-02)

Phases 0–5 executed. Core consolidation **done** — Paperclip now serves landing, UI, API, worker, and data locally with zero prod dependency.

| Phase | State | Notes |
|---|---|---|
| 0 Backup | ✅ done | Cold JSON backup of all 100 `internal` tables → `~/agnb-backup-2026-06-02/` (schema.json + data/*.json + dump.mjs + load-local.mjs). 66 MB. Contains secrets — keep out of git. |
| 1 Auth | ✅ done | Landing+login at `/auth` (`ui/src/pages/Landing.tsx`), `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, better-auth, board claimed. Trusted origins + `BETTER_AUTH_SECRET` in instance `.env`. |
| 2 Local E2E | ✅ done | Whole app runs offline from prod. UI verified rendering local data (campaigns/mentions/experiments/buckets). |
| 3 Data | ✅ done | Supabase `internal` → local Postgres schema `agnb` (100 tables, ~125k rows). **Backup-load repairs:** restored 397 column defaults + missing unique constraints (loader had kept only PKs/dropped defaults). |
| 4 Backend reads | ✅ done | 16 route groups, ~50 read/CRUD endpoints under `/api/agnb/*` (`server/src/agnb/groups/*.ts`), same-origin. UI clients (`ui/src/api/agnb*.ts`) flipped to a `ported()` same-origin helper per endpoint. |
| 5 Worker | ✅ done | Server-side scheduler (`server/src/agnb/scheduler.ts`) + 26 jobs (`server/src/agnb/jobs/*.ts`, registry in `jobs/registry.ts`). Opt-in via `PAPERCLIP_AGNB_JOBS=true`. Mgmt API `/api/agnb/jobs` (list/run/toggle, instance-admin). 21 enabled, 5 side-effecting default-OFF. Missing Supabase relations recreated in `server/src/agnb/migrations/0001_*.sql` (bucket_rollup view, pipeline_move_log table, rss_items url unique index). |
| 6 Retire AGNB | ⏳ pending | DNS cutover + repo archive NOT done (needs explicit go). |

### Job enablement (Phase 5)
- **Enabled (21):** rss-sync, rocket-personas, rocket-products, inbox-sync, blog-auto-drafter, changelog-drafter, gap-analyzer, content-audit, tag-replies, gsc-rank-tracker, sitemap-scraper, backlink-prospector, backlink-health, link-strength, posthog-sync, daily-brief, daily-digest, renewal-reminders, crm-hygiene-scan, utm-hygiene-scan, whatsapp-intake.
- **Default-OFF (side effects — enable via `POST /api/agnb/jobs/:key/toggle?enabled=true`):** notification-dispatcher (slack/email send), newsletter-drafter (send), linkedin-poster (live LinkedIn post), preview-leads (Rocket quota), csv-upload (no in-process input).

### Remaining loose ends
1. **Write/LLM/external route endpoints** still cross-origin in some UI clients (createPersona, pipeline board/move/create, invoices/create, *ai* drafts) — many now overlap ported jobs. Port the pure-DB writes; leave true-external ones pointing at services or fold into jobs.
2. **Secondary env keys** unset → those jobs self-skip: `GSC_PROPERTY`, `POSTHOG_PROJECT_ID`, `NOTIFY_TO_EMAILS`, `LINKEDIN_ACCESS_TOKEN`/`LINKEDIN_AUTHOR_URN`, `OPENPAGERANK_API_KEY`. 26 primary integration keys already copied into instance `.env`.
3. **`bucket_rollup`** returns zeros until `campaign_drafts` is populated (run a Rocket sync that links buckets↔campaigns).
4. **Disk-backed jobs** (content-audit, gap-analyzer, link-strength) degrade gracefully — they read `content/blog/*.mdx` which doesn't exist on the server; DB phases run.
5. **Local test user** `test-agnb@local.dev` granted instance_admin for verification — local dev only; remove before any shared use.
6. Phase 6 retire (domain repoint, AGNB repo archive, CORS teardown).

### Key files added
- `server/src/agnb/routes.ts` + `groups/*.ts` (17 group files incl. jobs mgmt)
- `server/src/agnb/helpers.ts`, `scheduler.ts`, `jobs/{types,registry}.ts` + 26 job files + `lib/*` (ported AGNB helpers)
- `server/src/agnb/migrations/0001_views_and_missing_tables.sql`
- `ui/src/pages/Landing.tsx`; `ui/src/api/agnb*.ts` + `marketing.ts` + `pipeline.ts` (same-origin cutover)
- `~/agnb-backup-2026-06-02/` (backup + load scripts, outside repo)

---

## 1. Current architecture (where we start)

```
┌─────────────────────────────┐         cross-origin fetch          ┌──────────────────────────────┐
│  Paperclip UI (React/Vite)  │  ───────────────────────────────▶  │  AGNB Next.js app             │
│  ui/src/pages/Campaigns.tsx │   credentials: include              │  www.allgasnobrakes.online    │
│  ui/src/api/agnb*.ts (14)   │   cookie .allgasnobrakes.online     │  236 routes /api/agnb/*       │
└─────────────────────────────┘                                     │  27 worker jobs /api/internal │
            │                                                        └───────────────┬──────────────┘
            │ same-origin /api/* (core)                                              │ supabase-js
            ▼                                                                        ▼
┌─────────────────────────────┐                                     ┌──────────────────────────────┐
│  Paperclip server (Express) │                                     │  Supabase project             │
│  better-auth + Postgres     │                                     │  bcslmvndyrdnacbaxjpg         │
│  core: companies/issues/... │                                     │  `internal` schema, 100 tbls  │
└─────────────────────────────┘                                     └──────────────────────────────┘
```

Two deploys, two auth systems, two databases. The Paperclip UI is just a cross-origin client of AGNB.

### Key facts (verified)
- **UI ported:** `ui/src/pages/` has Campaigns, Mentions, Blog, Experiments, Inbox, Renewals, YoutubeTrends, LinkedinSeries, LinkedinRepurpose, WinLoss, Demos, Newsletter, IdeaInbox, etc. API clients: `ui/src/api/agnb{Blog,Campaigns,Client,Experiments,Inbox,LinkedinQueue,Mentions,Misc,Ops,Pages,Renewals,Research,Team,Youtube}.ts` + `marketing.ts`.
- **`agnbClient.ts`** points at `VITE_AGNB_BASE_URL ?? "https://www.allgasnobrakes.online"`, prefix `/all-gas-no-brakes/api/agnb`, `credentials: "include"`.
- **AGNB backend:** 236 `route.ts` files under `app/all-gas-no-brakes/api/agnb/`, ~50 helper modules in `lib/agnb/`.
- **Worker:** 27 jobs under `app/all-gas-no-brakes/api/internal/*`, triggered via `POST /api/agnb/crons/run?path=/api/internal/<job>` (external scheduler hits this). Jobs listed in §6.
- **Data:** Supabase `internal` schema, 100 tables. Sample row counts: `rocket_campaigns` 26, `rocket_senders` 13, `blog_drafts` 34, `hubspot_deals` 4.
- **Auth (AGNB):** custom HMAC cookie (`agnb_session`), allowlist (`AGNB_USERS` / domain `AGNB_DOMAIN`+password). RBAC in `lib/agnb/rbac.ts` (admin/operator/viewer). Google OAuth only for GSC.
- **Auth (Paperclip):** better-auth, email+password, `instance_user_roles`. Landing+login already built (`ui/src/pages/Landing.tsx`).

---

## 2. Target architecture (where we land)

```
┌───────────────────────────────────────────────────────────────┐
│  Paperclip monorepo (one deploy)                                │
│                                                                 │
│  ui/  React SPA   ── same-origin /api/* ──┐                     │
│                                           ▼                     │
│  server/  Express + better-auth                                 │
│    /api/*          core (companies/issues/agents/routines)      │
│    /api/agnb/*     ported AGNB routes (236 → grouped handlers)  │
│    routines/agents replace the 27 cron jobs                     │
│                                           │                     │
│                                           ▼                     │
│  Postgres (embedded local / hosted prod)                        │
│    public   schema  → Paperclip core                            │
│    agnb     schema  → migrated AGNB data (ex-Supabase internal) │
└───────────────────────────────────────────────────────────────┘
```

One repo, one deploy, one DB, one auth, one cron mechanism.

---

## 3. Migration phases (ordered, each shippable)

### Phase 0 — Prep & safety (½ day)
- [ ] Full backup of Supabase `internal` schema (see §5 dump step). Keep raw SQL dump in cold storage.
- [ ] Snapshot list of all 236 routes + 27 jobs into a tracking sheet (port checklist).
- [ ] Add `VITE_AGNB_BASE_URL` to `ui/.env.local` pointing at a **local** AGNB (`http://localhost:3000`) so dev never touches prod.
- [ ] Confirm Paperclip server `DATABASE_URL` strategy (local embedded for dev; hosted for prod).

### Phase 1 — Auth cutover (1–2 days)
AGNB cookie allowlist → Paperclip better-auth (already the login path on the landing page).
- [ ] Create real better-auth users for each AGNB allowlist entry (`AGNB_USERS`).
- [ ] Map AGNB RBAC roles → Paperclip roles: `admin`→`instance_admin`; `operator`→company `owner`/`member`; `viewer`→read-only membership. Port the write-lock (viewer blocks mutating verbs) into Paperclip middleware if needed.
- [ ] Replace any `lib/agnb/session.ts` / `rbac.ts` checks in ported routes with Paperclip's `resolveSession` + access guards.
- [ ] Keep Google OAuth (GSC) as-is initially — it's orthogonal (token storage in `oauth_tokens`).
- **Exit:** every protected surface gated by better-auth; no `agnb_session` dependency.

### Phase 2 — Local end-to-end (1 day)
- [ ] Run AGNB locally (`cd agnb && pnpm dev`, port 3000) against a **local copy** of the data (Phase 3 dump) or read-only prod.
- [ ] Point Paperclip UI at it via `VITE_AGNB_BASE_URL=http://localhost:3000`.
- [ ] Verify all AGNB pages render locally end-to-end. This is the safety net before backend port.
- **Exit:** full app works locally, zero prod calls.

### Phase 3 — Data migration: Supabase `internal` → Paperclip `agnb` schema (2–3 days)
See §5 for exact commands.
- [ ] `pg_dump` the `internal` schema (schema + data) from Supabase.
- [ ] Rename target schema `internal` → `agnb` (avoid colliding with any reserved usage; explicit & greppable).
- [ ] Load into Paperclip's Postgres alongside `public` (core). They coexist — different schemas, one DB, one connection.
- [ ] Add a Paperclip db migration that **adopts** the `agnb` schema (or document it as plugin/external-owned so Paperclip's migration runner doesn't try to manage it). See `packages/db/src/check-migration-numbering.ts` conventions.
- [ ] Decide ongoing ownership: AGNB tables evolve via their own SQL migrations checked into `server/src/agnb/migrations/` (kept separate from core `packages/db/src/migrations/`).
- **Exit:** all 100 tables + rows live in Paperclip's DB under `agnb` schema; queryable via the server's pool.

### Phase 4 — Backend port: 236 routes → `server/src/agnb/*` (the big lift, incremental)
Port **group by group**, highest-value first. After each group, flip the UI's client for that group from cross-origin to same-origin and delete the AGNB routes.

Order (by UI value & row counts):
1. `campaigns` (2) + `rocket` (11) — the headline data (26 campaigns, 13 senders)
2. `inbox` (3) + `comments` (2) + `replies`/`reply-drafts` (2)
3. `pipeline` (9) + `attribution` (3) + `forecast`/`funnel`/`cohorts` (3)
4. `buckets` (12) + `experiments` (3)
5. `blog` (6) + `blog-automation` + `content`/`content-audit`/`content-performance`
6. `linkedin` (9) + `linkedin-queue`/`linkedin-series`/`linkedin-hooks` + `youtube` (11)
7. `inbound` (8 syncs) + `mentions` + `reviews` + `sov` + `backlinks` (3)
8. `team` (5) + `renewals` + `invoices` (3) + `win-loss` (2)
9. `icps` (3) + `targeting` + `saved-views` + `leads` (3) + `demos` + `csv`
10. remainder: `settings`, `integrations`, `credentials`, `notifications`, `health`, `me`/`whoami`, `audit`/`entity-audit`, `db`, `maintenance`, `studio`, `workflow-recipes`, `press-release(s)`, `whatsapp`, `quota`, `sidebar-*`, `search`, etc.

Per-group mechanics:
- [ ] Create `server/src/agnb/routes/<group>.ts` Express router. Mount under `/api/agnb/<group>` in `server/src/app.ts` (next to `app.use("/api/auth", ...)`).
- [ ] Port the Next.js `route.ts` handler bodies → Express handlers. Logic is mostly Supabase CRUD → swap `supabase-js` calls for Paperclip's `pg` pool against the `agnb` schema (schema-qualify table names or set `search_path`).
- [ ] Port needed `lib/agnb/*` helpers → `server/src/agnb/lib/*` (see §7 helper inventory). Replace `lib/agnb/supabaseAdmin` with the server pool; replace `lib/agnb/session`/`rbac` with Paperclip auth.
- [ ] Flip `ui/src/api/agnb<Group>.ts`: drop the cross-origin base, call same-origin `/api/agnb/<group>`. (Often a one-line change if all clients route through `agnbClient.ts` — consider switching its `AGNB_BASE` to `""` once **all** groups are ported.)
- [ ] Delete the corresponding AGNB `route.ts` files.
- **Exit per group:** UI group served same-origin from Paperclip; AGNB routes for it removed.
- **Phase exit:** `agnbClient.ts` `AGNB_BASE = ""` (same-origin); zero cross-origin calls remain.

### Phase 5 — Worker port: 27 cron jobs → Paperclip routines (2–3 days)
AGNB worker = external scheduler hitting `POST /api/agnb/crons/run?path=/api/internal/<job>`. Replace with Paperclip's native scheduling.

Two options per job:
- **Routine (preferred for agentic jobs):** model as a Paperclip routine (cron trigger → agent run). Good for `blog-auto-drafter`, `daily-brief`, `daily-digest`, `gap-analyzer`, `newsletter-drafter`, `changelog-drafter`, `tag-replies`.
- **Server scheduled task (for pure data syncs):** a lightweight server-side scheduler entry calling the ported handler directly. Good for `gsc-rank-tracker`, `rss-sync`, `posthog-sync`, `inbox-sync`, `*-sync`, `*-hygiene-scan`, `renewal-reminders`, `notification-dispatcher`, `sitemap-scraper`, `link-strength`, `backlink-*`, `preview-leads`, `whatsapp-intake`, `rocket/personas`, `rocket/products`.
- [ ] Port each `app/.../api/internal/<job>/route.ts` body → `server/src/agnb/jobs/<job>.ts`.
- [ ] Register schedules (map each job's external cron cadence → routine cron trigger or server scheduler).
- [ ] Keep the `crons/run` HTTP entry temporarily as a manual trigger for parity testing.
- **Exit:** all 27 jobs run from Paperclip; external scheduler decommissioned.

### Phase 6 — Retire AGNB (½ day)
- [ ] Confirm `agnbClient.ts` is fully same-origin and all 236 routes deleted.
- [ ] Move sidecars (`LINKEDIN_SIDECAR_URL`, `JUSTDIAL_SIDECAR_URL`) config into Paperclip env.
- [ ] Tear down `www.allgasnobrakes.online` Next.js deploy; repoint domain to Paperclip.
- [ ] Archive the `agnb` repo (keep for reference; tag final commit).
- [ ] Remove `VITE_AGNB_BASE_URL` usage.
- **Exit:** single Paperclip deploy serves everything.

---

## 3b. PHASE 6 CUTOVER RUNBOOK (executable)

⚠️ **Irreversible steps marked 🔴. Do NOT start until the freeze + fresh data sync (steps 1–3) are complete — the local `agnb` schema is a point-in-time snapshot and prod keeps diverging until frozen.**

### Pre-cutover (reversible, do anytime)
- [ ] **Pick the deploy target DB.** Prod Paperclip needs a Postgres with BOTH `public` (core) and `agnb` schemas. Either a fresh hosted PG, or reuse the existing Supabase project (`bcslmvndyrdnacbaxjpg`) — Paperclip core in `public`, AGNB in `agnb`. Set `DATABASE_URL` accordingly.
- [ ] **Stage env on the deploy target.** Copy the instance `.env` keys: `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL=https://allgasnobrakes.online`, `BETTER_AUTH_TRUSTED_ORIGINS=https://allgasnobrakes.online`, `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `PAPERCLIP_DEPLOYMENT_EXPOSURE=public`, `PAPERCLIP_AGNB_JOBS=true`, and all 28 AGNB integration keys (+`GSC_PROPERTY`, `OPENPAGERANK_API_KEY`). Generate a NEW `BETTER_AUTH_SECRET` for prod.
- [ ] **Build passes** on the deploy artifact: `pnpm run build`.
- [ ] **Create real users** for each AGNB allowlist member; plan board-claim for the first admin.

### Cutover window (🔴 = irreversible / disruptive)
1. [ ] 🔴 **Freeze prod AGNB writes.** Put `www.allgasnobrakes.online` in maintenance / disable its cron worker so Supabase `internal` stops changing.
2. [ ] **Fresh data sync** (NOT the yesterday snapshot):
   - Preferred: `pg_dump` the live `internal` schema → load into deploy DB as `agnb` (see §5 — needs the Supabase DB password).
   - Or re-run `~/agnb-backup-2026-06-02/dump.mjs` then `load-local.mjs` pointed at the deploy DB (`LOCAL_DSN=...`). Then re-run `server/src/agnb/migrations/0001_*.sql` (views + unique indexes + defaults).
   - [ ] Verify row counts match prod (campaigns, deals, blog_drafts, etc.).
3. [ ] **Re-auth Google (GSC).** The stored refresh token is expired (`invalid_grant`). Reconnect via the Google OAuth start flow on the new instance so `gsc-rank-tracker` works; re-point the OAuth redirect URI to the Paperclip domain in Google Cloud console.
4. [ ] **Deploy Paperclip** to prod infra with the staged env + `DATABASE_URL`. Boot, confirm `/api/health` shows `authenticated` + bootstrap, claim board as admin.
5. [ ] **Smoke test on the deploy URL** (pre-DNS): sign in, load campaigns/mentions/pipeline/blog, `GET /api/agnb/jobs` lists 26, run one job manually.
6. [ ] 🔴 **Repoint DNS** `allgasnobrakes.online` → Paperclip deploy. Wait for propagation.
7. [ ] **Verify prod** end-to-end on the real domain. Watch logs for `agnb job` errors; toggle the 5 default-OFF jobs on only after confirming external creds.
8. [ ] 🔴 **Decommission AGNB**: stop the old Vercel Next.js deploy; archive the `agnb` repo (`git tag agnb-final && git push --tags`, then archive on GitHub).

### Post-cutover cleanup
- [ ] Port/retire the remaining cross-origin **write/LLM** endpoints (createPersona, pipeline move/create, invoices/create, *ai* drafts). Until done, set prod `VITE_AGNB_BASE_URL` to a still-running headless AGNB API, OR finish porting them first. **Do not flip `agnbClient.ts` `AGNB_BASE=""` until every endpoint it serves exists same-origin.**
- [ ] Remove the local dev test user `test-agnb@local.dev` (instance_admin) from any shared DB.
- [ ] Move sidecars (`LINKEDIN_SIDECAR_URL`, `JUSTDIAL_SIDECAR_URL`, WhatsApp) into Paperclip env or fold in.
- [ ] Delete AGNB CORS allowances + `.allgasnobrakes.online` cookie scoping.

### Rollback (if cutover fails)
- DNS back to the old Vercel AGNB deploy (kept running until step 8). Prod data was frozen at step 1, so no divergence to reconcile. Un-freeze AGNB writes.

---

## 4. Effort & sequencing summary

| Phase | Scope | Rough effort | Risk |
|---|---|---|---|
| 0 Prep | backup, checklist, env | ½ day | low |
| 1 Auth | better-auth cutover + RBAC map | 1–2 days | medium |
| 2 Local E2E | local AGNB + VITE base | 1 day | low |
| 3 Data | dump `internal` → `agnb` schema | 2–3 days | medium (data integrity) |
| 4 Backend | 236 routes, 10 groups | 2–4 weeks | high (volume) |
| 5 Worker | 27 jobs → routines/scheduler | 2–3 days | medium |
| 6 Retire | DNS, teardown | ½ day | low |

Phase 4 dominates; it's mechanical (mostly Supabase CRUD → pg) and parallelizable across the 10 groups.

---

## 5. Data migration commands (Phase 3)

Supabase project `bcslmvndyrdnacbaxjpg`, schema `internal`. Use the Supabase **direct connection string** (Project Settings → Database) or run via the Management API. Dump then load into Paperclip's Postgres.

```bash
# 1. Dump internal schema (structure + data) from Supabase
#    Get DIRECT connection string from Supabase dashboard (has the DB password).
pg_dump "postgresql://postgres:<PW>@db.bcslmvndyrdnacbaxjpg.supabase.co:5432/postgres" \
  --schema=internal --no-owner --no-privileges \
  -f agnb_internal_dump.sql

# 2. Rename schema internal -> agnb in the dump (explicit, greppable)
sed -i '' 's/\binternal\./agnb./g; s/SCHEMA internal/SCHEMA agnb/g; s/schema internal/schema agnb/g' agnb_internal_dump.sql
#    (review the diff — only schema-qualified refs should change)

# 3. Load into Paperclip's Postgres
#    Local embedded PG is at 127.0.0.1:54329 (user/pass paperclip/paperclip, db paperclip).
psql "postgresql://paperclip:paperclip@127.0.0.1:54329/paperclip" \
  -c "CREATE SCHEMA IF NOT EXISTS agnb;" \
  -f agnb_internal_dump.sql
```

> No `psql`/`pg_dump` on PATH locally — embedded Postgres ships only `initdb`/`pg_ctl`/`postgres`. Install client tools (`brew install libpq` then add to PATH) or run the dump/load from a box that has them. The DB password is NOT the Supabase service-role key — get the real DB password from the Supabase dashboard (or reset it, but resetting breaks the live AGNB app until its env is updated).

Ownership going forward: AGNB schema migrations live in `server/src/agnb/migrations/` and run on a separate track from core (`packages/db/src/migrations/`). Update `check-migration-numbering.ts` scope or exclude the `agnb` dir so core numbering checks don't trip.

---

## 6. The 27 worker jobs (Phase 5 checklist)

`approval/[id]`, `backlink-health`, `backlink-prospector`, `blog-auto-drafter`, `changelog-drafter`, `content-audit`, `crm-hygiene-scan`, `csv-upload`, `daily-brief`, `daily-digest`, `gap-analyzer`, `gsc-rank-tracker`, `inbox-sync`, `link-strength`, `linkedin-poster`, `newsletter-drafter`, `notification-dispatcher`, `posthog-sync`, `preview-leads`, `renewal-reminders`, `rocket/personas`, `rocket/products`, `rss-sync`, `sitemap-scraper`, `tag-replies`, `utm-hygiene-scan`, `whatsapp-intake`.

---

## 7. `lib/agnb/*` helper inventory (Phase 4 dependency port)

Port these into `server/src/agnb/lib/` as routes need them. Group by concern:

- **Auth/session (replace with Paperclip auth):** `session.ts`, `rbac.ts`, `api-token.ts`, `login-log.ts`, `cors.ts`
- **Data access (replace supabase-js with pg pool):** anything importing `supabaseAdmin`; `events.ts`, `audit.ts`, `entity-audit` helpers, `notification-reads.ts`, `notify.ts`
- **AI:** `gemini-json.ts`, `gemini-summary.ts`, `blog-style-rag.ts`, `reply-tagger.ts`, `channel-classifier.ts`, `seo-score.ts`, `serp-analysis.ts`, `keyword-research.ts`, `search-knowledge.ts`
- **Integrations:** `apollo.ts`, `razorpay.ts`, `google-oauth.ts`, `justdial-sidecar.ts`, `linkedin-sidecar.ts`, `rss-parser.ts`, `sitemap-scraper.ts`, `backlink-discovery.ts`, `community-research.ts`, `paperclip.ts`
- **Domain logic:** `attribute.ts`, `verdict.ts` (experiments stats), `blog-scheduler.ts`, `send-guard.ts`, `banned-phrases.ts`, `team-routing.ts`, `pipeline-board-data.ts`, `marketing-list.ts`, `customer-quotes.ts`, `asset-vars.ts`, `board-types.ts`
- **Nav/search (UI-side, may already be ported):** `search-registry.ts`, `sub-nav-config.ts`, `search-registry.ts`

---

## 8. Open decisions / risks to track

1. **DB password** for the dump — must come from Supabase dashboard; service-role key won't work for `pg_dump`. Resetting it breaks live AGNB until its env updates (do dump before any reset, or schedule downtime).
2. **Google OAuth (GSC) tokens** in `oauth_tokens` — migrate with the schema; re-verify redirect URIs point at Paperclip's domain after Phase 6.
3. **Sidecars** (LinkedIn `:8080`, JustDial `:8787`) — external processes; decide whether to fold into Paperclip or keep as separate services it calls.
4. **Migration numbering** — keep `agnb` schema migrations off the core numbering track to avoid `check:migrations` failures.
5. **CORS removal** — once same-origin, delete AGNB's `lib/agnb/cors.ts` allowances and the `.allgasnobrakes.online` cookie scoping.
6. **Secrets** — AGNB env has ~20 integration keys (Apollo, Razorpay, HubSpot, PostHog, Deepgram, Resend, Sentry, Slack, Rocket MCP). Move into Paperclip's secret store / env.

---

## 9. Immediate next actions (after this doc)

1. Phase 0 backup: dump `internal` now (cold copy) — even before deciding timing.
2. Phase 1+2: wire better-auth fully + stand up local AGNB with `VITE_AGNB_BASE_URL` so all dev is local.
3. Begin Phase 4 group 1 (`campaigns` + `rocket`) as the reference port; it sets the pattern for the other 9 groups.
