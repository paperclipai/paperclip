# AGNB (All Gas No Brakes) — Ops Runbook

> Operator notes for the `redigvijay/paperclip` fork deployed as **All Gas No Brakes** at
> https://allgasnobrakes.online. Written for a fresh Claude Code / engineer to get oriented fast.
> This fork is a rebrand of Paperclip; upstream is `paperclipai/paperclip`.

---

## 0. TL;DR — the stuff that bites

| Thing | Value |
|---|---|
| Live URL (canonical) | `https://allgasnobrakes.online` (apex) |
| `www.` | 301-redirects to apex via **Spaceship URL Redirect** (FreeSSL). Not Cloud Run. |
| Hosting | **GCP Cloud Run**, service `paperclip`, region `asia-south1` |
| GCP project | `gen-lang-client-0289669375` |
| Cloud Run URL | `https://paperclip-o5uipy5zeq-el.a.run.app` |
| Database | Cloud SQL `gen-lang-client-0289669375:asia-south1:paperclip-db` (Postgres, db `paperclip`) |
| DNS host | **Spaceship** (`launch1/launch2.spaceship.net`) — NOT Google Cloud DNS |
| Deploy | **MANUAL**. No auto-deploy on git push. See §4. |
| Deploy target branch | `fork/master` (fork = `redigvijay/paperclip`) |
| gcloud account | `admin@hirefinn.ai` |

**Two independent auth layers, both expire with `invalid_rapt` and break different things:**
- `gcloud auth application-default login` → ADC → used by **cloud-sql-proxy** (local DB). Breaks local dev when stale.
- `gcloud auth login` → gcloud CLI user creds → used by **builds/deploy**. Breaks deploy when stale.

---

## 1. Git layout

```
origin  https://github.com/paperclipai/paperclip.git   # UPSTREAM OSS — do NOT push rebrand commits here
fork    https://github.com/redigvijay/paperclip.git     # OUR deploy repo
```

- Work happens on `deploy/agnb-pages-v<version>` branches (e.g. `deploy/agnb-pages-v2026.529.0`).
- **`fork/master` is the deployable branch.** The deploy branch is fast-forwarded into it.
- Local `master` tracks upstream and diverges — ignore it for deploys; use `fork/master`.

### Merge + push (what "merge and push" means here)
The deploy branch is normally a clean fast-forward over `fork/master`:
```bash
git fetch fork
git merge-base --is-ancestor fork/master HEAD && echo "FF ok"   # verify fast-forward
git push fork HEAD:master                                        # update deploy branch -> master
git push fork HEAD:deploy/agnb-pages-vX.Y.Z                      # keep the deploy branch ref in sync
# NEVER: git push origin (that's upstream OSS)
```
Pushing does **not** deploy. Deploy is a separate manual step (§4).

---

## 2. Architecture / request flow

**Production:**
```
browser ──▶ https://allgasnobrakes.online ──▶ Cloud Run service `paperclip` (asia-south1)
                                                   │
                                                   └─▶ Cloud SQL `paperclip-db` (via Cloud Run's built-in connector)
browser ──▶ https://www.allgasnobrakes.online ──301──▶ apex   (Spaceship FreeSSL redirect, never hits Cloud Run)
```
- Cloud Run runs in `authenticated` deployment mode (health omits `version`).
- `Server: Google Frontend` + Google Trust Services cert = Cloud Run direct domain mapping.

**Local dev:**
```
Vite UI :5173 ──proxy /api/*──▶ backend :3100 ──▶ cloud-sql-proxy 127.0.0.1:5432 ──▶ Cloud SQL paperclip-db
```
- `DATABASE_URL=postgresql://postgres:***@127.0.0.1:5432/paperclip`
- Vite proxy target is `http://localhost:3100` (`ui/vite.config.ts`).
- cloud-sql-proxy binary: `~/.paperclip/bin/cloud-sql-proxy`, launched by the dev runner.
- Logs: `~/.paperclip/logs/server.log`, `~/.paperclip/logs/proxy.log`.

---

## 3. Common failure: "Failed to load health (500)" in preview (and ALL /api 500s)

**Symptom:** UI shows `Failed to load health (500)`. Network tab shows *every* `/api/*` → 500.

**Root cause chain (most common):**
1. gcloud **ADC** token expired → `~/.paperclip/logs/proxy.log` shows
   `invalid_grant ... invalid_rapt` and `failed to connect to instance`.
2. cloud-sql-proxy can't reach Cloud SQL → resets connections (`read ECONNRESET`).
3. Backend dies at startup in `inspectMigrations` (`packages/db/src/client.ts:~605`) →
   `~/.paperclip/logs/server.log` shows `Paperclip server failed to start ... ECONNRESET`.
4. Nothing listens on `:3100` → Vite proxy returns **500** for all `/api/*` (incl. `/api/health`).

The 500 is a *downstream symptom*, not a health-handler bug. (`ui/src/api/health.ts:37` just reports any non-OK status. The handler `server/src/routes/health.ts` returns 503 — not 500 — for a reachable-but-failing DB.)

**Diagnose:**
```bash
lsof -nP -iTCP:5432 -sTCP:LISTEN          # who owns 5432 (should be cloud-sql-proxy)
lsof -nP -iTCP:3100 -sTCP:LISTEN          # backend listening? (empty = crashed)
tail -40 ~/.paperclip/logs/proxy.log      # look for invalid_rapt / ECONNRESET
tail -40 ~/.paperclip/logs/server.log     # look for "failed to start"
curl -s http://localhost:3100/api/health  # 200 JSON when healthy
```

**Fix:**
```bash
gcloud auth application-default login     # refresh ADC (interactive, browser)
# the OLD proxy keeps the stale token — it does NOT hot-reload ADC. Kill it + the server:
ps aux | grep -E "cloud-sql-proxy|dev-watch|dev-runner" | grep -v grep   # find pids
kill <cloud-sql-proxy-pid> <pnpm-server-pid> ...
pnpm dev                                   # fresh start picks up new ADC
curl -s http://localhost:3100/api/health   # expect 200
```
> Key gotcha: re-authing ADC alone is NOT enough — the already-running cloud-sql-proxy holds the
> stale token. You must kill it so a fresh proxy spawns with the new creds.

---

## 4. Deploy to live (MANUAL)

There is **no** Cloud Build trigger / GitHub auto-deploy. Pushing git changes nothing on the live site.
Deploy is `gcloud run deploy --source` (builds the Dockerfile via Cloud Build, then rolls out).

**Prereqs:**
```bash
gcloud auth login                          # CLI creds (separate from ADC). Fixes "Reauthentication failed".
gcloud config get-value project            # should be gen-lang-client-0289669375
git status                                 # clean tree; --source deploys the working dir
git rev-parse --short HEAD                 # confirm you're on the commit you intend to ship
```

**Deploy:**
```bash
gcloud run deploy paperclip \
  --source . \
  --region asia-south1 \
  --project gen-lang-client-0289669375
```
- Takes ~10–12 min (last build was ~10m35s). Builds image into
  `asia-south1-docker.pkg.dev/gen-lang-client-0289669375/cloud-run-source-deploy/paperclip`.
- `--source` redeploy **preserves** existing env vars / secrets / Cloud SQL connection — don't re-pass them.
- Run it in the background and watch; build logs stream.

**Verify rollout (no auth needed — health hides version in authenticated mode):**
```bash
# the UI bundle hash in index.html changes when a new build goes live:
curl -s https://allgasnobrakes.online/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js' | head -1
curl -s -o /dev/null -w '%{http_code}\n' https://allgasnobrakes.online/api/health   # expect 200
gcloud run services describe paperclip --region asia-south1 \
  --format='value(status.latestReadyRevisionName)'        # new revision name
gcloud builds list --limit 3                                # build STATUS=SUCCESS
```
Poll the bundle hash until it flips off the old value = new build is serving.

**Useful inspect commands:**
```bash
gcloud run services list                                            # service, region, url, revision
gcloud builds list --limit 5                                        # recent builds + status
gcloud beta run domain-mappings list --region asia-south1           # domain mappings
```

---

## 5. www → apex redirect (Spaceship)

DNS is at **Spaceship**, not GCP. The www redirect is a Spaceship **URL Redirect**, not a Cloud Run mapping.

**Setup (Spaceship dashboard → domain `allgasnobrakes.online` → URL Redirect tab → Subdomain redirects):**
- Redirect from: `www`  •  Redirect to: `https://allgasnobrakes.online`  •  Type: **301 (Permanent)**
- FreeSSL (Spaceship-issued cert) is automatic — required, else browsers get `ERR_SSL_PROTOCOL_ERROR`.
- Do **NOT** use the top "Redirect traffic to your chosen domain" box — that redirects the apex itself.
- If an old `www` CNAME exists under **DNS Records**, delete it (it shadows the redirect and points www at Cloud Run, which has no www cert).

**Verify:**
```bash
dig +short www.allgasnobrakes.online        # should resolve to Spaceship/FreeSSL infra (15.197.x.x), NOT 8.233.82.26
curl -sI https://www.allgasnobrakes.online | grep -iE 'HTTP/|location'   # 301 -> https://allgasnobrakes.online
```
> Cert issuance after creating the redirect can take ~15 min–1h. Until then HTTP redirects work but
> HTTPS shows `ERR_SSL_PROTOCOL_ERROR`. Test in a fresh private window — browsers cache SSL failures.

---

## 6. Quick reference — IDs & paths

```
Repo root         /Users/apple/Documents/GitHub/paperclip
GCP project       gen-lang-client-0289669375
Cloud Run service paperclip  (region asia-south1)
Cloud Run URL     https://paperclip-o5uipy5zeq-el.a.run.app
Cloud SQL         gen-lang-client-0289669375:asia-south1:paperclip-db
DATABASE_URL      postgresql://postgres:***@127.0.0.1:5432/paperclip   (local, via proxy)
cloud-sql-proxy   ~/.paperclip/bin/cloud-sql-proxy
Logs              ~/.paperclip/logs/{server,proxy}.log
Vite proxy target http://localhost:3100   (ui/vite.config.ts)
gcloud account    admin@hirefinn.ai
Build artifact    asia-south1-docker.pkg.dev/gen-lang-client-0289669375/cloud-run-source-deploy/paperclip
```

Health handler: `server/src/routes/health.ts` · Health client/UI string: `ui/src/api/health.ts`
Hostname allowlist (why a host gets 403): `server/src/config.ts` (`PAPERCLIP_ALLOWED_HOSTNAMES`,
derived from `PAPERCLIP_AUTH_PUBLIC_BASE_URL`) + `server/src/middleware/private-hostname-guard.ts`.

---

## 7. Build / test (local)

```bash
pnpm build        # preflight workspace links + recursive build. UI emits a ~4MB chunk warning (cosmetic).
pnpm typecheck
pnpm test
pnpm dev          # full dev stack (server + cloud-sql-proxy + Vite UI on :5173)
```
