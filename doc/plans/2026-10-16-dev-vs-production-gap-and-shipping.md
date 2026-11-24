# Dev → Production Gap Analysis & Shipping Plan

Date: 2026-10-16
Status: Working analysis (not a PR). Supersedes nothing.

## Purpose
This instance is currently running **dev mode** (`pnpm dev` → `tsx src/index.ts`,
watch loop, embedded PGlite under `data/pglite`). The goal is to (1) enumerate
the concrete gaps between that dev posture and a real production deployment, and
(2) lay out a concrete path to ship this code to production.

Facts below are grounded in the current tree (16 Oct 2026). Anything that is a
decision/choice for the operator is flagged as **Decision**.

---

## 1. What "dev" and "production" actually mean here

| Axis | Dev (running now) | Production (target) |
|---|---|---|
| **Entry point** | `tsx src/index.ts` (TS from source, watch) | `node server/dist/index.js` (compiled TSC build) |
| **Runtime** | Local `tsx`, dev-watch auto-restart | Container (or `pnpm start`); single process, restart on crash/redeploy only |
| **Build** | On-the-fly; plugin-sdk/shared built ad hoc | Full multi-stage Dockerfile: build UI + plugin-sdk + server + vendored Rust `paperclip-runner` binary |
| **DB** | Embedded PGlite, `data/pglite`; `rm -rf data/pglite` to reset | Embedded Postgres (persisted bind mount) **or** external **PostgreSQL 17** |
| **Auth/exposure** | `authenticated` / `private` (from config.json); `--bind lan` | `authenticated`; `private` (LAN/VPN) **or** `public` (internet, TLS, rate-limited) |
| **Secrets** | Defaults / local master key; no explicit `BETTER_AUTH_SECRET` | `BETTER_AUTH_SECRET` + `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` required; via Secrets Manager/env |
| **Migrations** | `PAPERCLIP_MIGRATION_PROMPT=never PAPERCLIP_MIGRATION_AUTO_APPLY=true` (dev-watch sets both) | `PAPERCLIP_MIGRATION_AUTO_APPLY=true` explicit; doctor validates |
| **Observability** | None (OTLP unset → no-op tracer) | Optional OTLP endpoint; run-log in-instance; optional Sentry (cloud) |
| **Telemetry** | `enabled: true` (first-party, opt-out) | Same; operator can point at a backend or opt out |

Key insight: **the runtime "dev vs prod" axis is really two independent concerns**
Paperclip already separates (`doc/DEPLOYMENT-MODES.md`):
1. **Build/runtime**: source+watch vs compiled+container.
2. **Auth/exposure/bind**: `local_trusted` / `authenticated×private` /
   `authenticated×public` × `loopback|lan|tailnet|custom`.

We are currently on the "source+watch" side of (1) and `authenticated/private/lan`
on (2). Production typically means "compiled+container" + a deliberate choice on (2).

---

## 2. Gap analysis (concrete, per area)

### 2.1 Runtime / build
- **Gap:** Dev interprets TS from source with a watch loop. Production must run a
  **compiled `dist/`**. The server's `build` script (`server/package.json`) already
  does `prepare:runner-vendor` (builds the Rust `paperclip-runner`) → `tsc` →
  copies onboarding/built-ins/services + vendored runner binary → writes a build
  stamp. That is the exact artifact Docker's `production` target ships.
- **Gap:** Dev has no process supervision. Production image makes **tini**
  PID 1 (`docker-entrypoint.sh` `exec gosu node ...`) + compose `pids_limit: 2048`
  as the backstop against agent process leaks.
- **Decision:** Container vs bare `pnpm start`. Container is the supported,
  tested path (Dockerfile, compose, ECS, quadlet all target it). Bare
  `pnpm start` is only viable on a single long-lived host with manual service
  management (systemd/launchd) — less reproducible.

### 2.2 Database
- **Gap:** Dev uses embedded PGlite with no durable storage contract. Two
  production sub-options, both already wired (`config.ts`: `DatabaseMode =
  "embedded-postgres" | "postgres"`; `databaseUrl = process.env.DATABASE_URL ?? fileDbUrl`):
  1. **Embedded Postgres** — single container, data on a bind mount
     (`docker-compose.quickstart.yml`). Simplest; still a real durable PG data dir
     (not PGlite).
  2. **External PostgreSQL 17** — separate health-checked service
     (`docker-compose.yml`), `DATABASE_URL=postgres://paperclip:paperclip@db:5432/paperclip`,
     data on a bind mount so it's in the restic backup scope. Recommended for
     multi-container or any real HA posture.
- **Gap (security):** The compose file uses the default `POSTGRES_PASSWORD: paperclip`.
  **Must be replaced with a generated secret** in production; ideally external PG
  not on the same trusted host, or at minimum a strong generated password.
- **Migrations:** Dev forces auto-apply. Production should keep
  `PAPERCLIP_MIGRATION_AUTO_APPLY=true` but understand this is a rolling-upgrade
  behavior; the release pipeline additionally ships an **exact-source migrator**
  (see `doc/preview-release-artifacts.md`, `doc/cloud-build-readiness.md`) for
  canary/rollback. **Decision:** whether to gate migrations behind a
  maintainer step instead of auto-apply.

### 2.3 Secrets & auth
- **Gap:** Dev runs with `BETTER_AUTH_SECRET` unset (falls back to local
  defaults). Production **requires**:
  - `BETTER_AUTH_SECRET` (session signing) — `openssl rand -hex 32`
  - `PAPERCLIP_TOOL_ACTION_SIGNING_SECRET` — `openssl rand -hex 32`
  - LLM provider keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`) for agents to actually run
  - Optionally `GITHUB_TOKEN`, `PAPERCLIP_AGENT_JWT_SECRET`
- **Gap (public exposure):** Moving from `private` to `public` flips defaults
  (per DEPLOYMENT-MODES §3): explicit `PAPERCLIP_PUBLIC_URL` required, Better Auth
  **rate-limiting ON** by default, recommended `loopback` behind a reverse proxy
  (TLS termination at the front door), local-stdio MCP slots fail closed. This
  is the biggest security surface change and the main thing to get right.
- **Decision:** target exposure. `authenticated/private` (LAN/Tailscale/VPN) is
  the low-friction, low-risk first step. `public` (internet) is a separate,
  harder hardening exercise.

### 2.4 Networking / reachability
- **Gap:** Dev binds `0.0.0.0` (`--bind lan`). Production choices:
  - `loopback` behind a reverse proxy (recommended for public)
  - `lan` for private-network
  - `tailnet` for Tailscale-only
  - `custom` for a specific interface
- **Allowed hostnames:** Dev config lists LAN hosts (`100.92.91.108`, `pop-os`).
  Production needs `PAPERCLIP_ALLOWED_HOSTNAMES` set to the real access aliases
  and a correct `PAPERCLIP_PUBLIC_URL`.

### 2.5 Observability & telemetry (the three data paths)
- **Run log** (`heartbeat_run_events`, in-instance DB) — no change needed; data
  stays local. Fine as-is.
- **Telemetry** (first-party, opt-out, `enabled: true` in config.json) — goes to
  a Paperclip endpoint by default. **Decision:** keep on (recommended for a
  company-scoped deploy), opt out, or point at a self-hosted backend via
  `PAPERCLIP_TELEMETRY_BACKEND_URL/TOKEN`.
- **Observability (OTel)** — no-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
  Currently unset → no-op. **Decision:** set an OTLP endpoint in production if
  you want distributed traces; otherwise leave the no-op gate (it's a closed
  allowlist, no privacy review needed).

### 2.6 Backup / persistence / recovery
- **Gap:** Dev has `backup.enabled: true` (embedded PG) with 60-min interval /
  30-day retention in the local dir. Production should:
  - Use the durable PG data dir on a **restic-backup-scoped** mount (the compose
    comment documents this for the eywalink restic scope).
  - Run `pnpm db:backup` (`scripts/backup-db.sh`) on a schedule and verify
    restore.
  - For the ECS Fargate path: data on **EFS** (`transitEncryption: ENABLED`) +
    CloudWatch logs.
- **Gap:** Dev resets with `rm -rf data/pglite` — no recovery story. Production
  must have an actual **restore runbook** (see §3.6).

### 2.7 Agent runtime / adapters
- **Gap:** The production image installs agent CLIs (Claude, Codex, OpenCode)
  + common tools (`git`, `gh`, `curl`, `wget`, `ripgrep`, `python3`) in the
  build. Dev relies on the host already having them. If you deploy the
  container, this is handled; if bare-metal `pnpm start`, you must install the
  same toolchain. `docker/agent-runtime/` has per-adapter base images if you
  only need one runner.
- **Decision:** which adapters/LLM keys the production box needs (each key is a
  separate secret in §2.3).

### 2.8 CI/CD & release
- **Not a gap, a path.** The repo already ships:
  - `pnpm release` (`scripts/release.sh`) → canary/nightly/beta/stable npm tags +
    git tags + GitHub releases + rollback (`release:rollback`).
  - Docker multi-platform `production` + `cloud` targets published to
    `ghcr.io/paperclipai/paperclip` with Sigstore attestation
    (`doc/DOCKER.md`, "Standard images and downstream composition").
  - Downstream should **resolve immutable digests**, not mutable tags
    (attestation + exact-source migrator + own composed image).
- **Gap:** This local tree is not itself a published registry artifact. Shipping
  "to production" means either (a) build the image from this source and run it,
  or (b) consume the published image. **Decision:** build-from-source (this
  repo, this commit) vs pull the latest published standard image.

---

## 3. Shipping plan (concrete, ordered)

Assume the pragmatic, low-risk target: **self-hosted, containerized,
`authenticated/private`, external Postgres, on a single host in the existing
restic-backup scope.** Promote to `public` only as a follow-up.

### 3.1 Prepare the environment
1. Pick the host (existing `pop-os` / eywalink box is implied by the restic
   scope in the compose comment). Confirm Docker + compose available.
2. Confirm Node 24 (for any bare-metal steps). Container path handles its own.
3. Reserve port 3100 on the target host (do NOT collide with 3102 Umami /
   3104 Matomo).

### 3.2 Generate secrets (do this ONCE, store securely)
```sh
export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
export PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="$(openssl rand -hex 32)"
export PGPASSWORD="$(openssl rand -hex 16)"   # external PG
# LLM keys:
export ANTHROPIC_API_KEY="sk-ant-..."         # and/or OPENAI_API_KEY
```
Store these in the secret store (or the repo's `docker/.env`, gitignored).
**Never** commit them.

### 3.3 Build the image
```sh
# from repo root
docker build -t paperclip-prod --build-arg USER_UID=$(id -u) --build-arg USER_GID=$(id -g) .
# or, if building for a registry:
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/paperclip:$(git rev-parse HEAD) --push .
```
Verify the build stamp + runner vendor binary present. (The Dockerfile fails the
build if `server/dist/index.js` is missing.)

### 3.4 Bring up Postgres + server (full stack)
```sh
cd docker
BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
PAPERCLIP_TOOL_ACTION_SIGNING_SECRET="$PAPERCLIP_TOOL_ACTION_SIGNING_SECRET" \
PAPERCLIP_PUBLIC_URL="http://<access-host>:3100" \
  docker compose -f docker-compose.yml up --build
```
Before running: edit `docker-compose.yml` to (a) set a real
`POSTGRES_PASSWORD` (or use a named secret), (b) confirm the PG bind mount path
is in the restic scope. The compose already health-checks `db` before starting
`server`.

> For the **simplest** first bring-up, use `docker-compose.quickstart.yml`
> (single container, embedded Postgres on the bind mount) to validate the image,
> then move to the full-stack compose once DB persistence is confirmed.

### 3.5 Set exposure/bind correctly
- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`
- `PAPERCLIP_PUBLIC_URL=<the URL users/browser will actually use>` (set it when
  the host is not `localhost`).
- `PAPERCLIP_ALLOWED_HOSTNAMES=<lan/tailscale aliases>` (comma-separated).
- If private-network only, keep bind `lan`. If behind a front door, switch to
  `loopback` + a reverse proxy.

### 3.6 Recovery / backup runbook (write this down, don't just rely on auto)
- **Backup:** schedule `pnpm db:backup` (or the container equivalent) at
  ≤60 min; confirm artifacts land in the restic-scoped dir.
- **Restore:** stop `server`, restore PG data dir from the last known-good
  backup, start `server`, hit `/api/health`. For embedded-PG quickstart, restore
  the whole `PAPERCLIP_DATA_DIR` bind mount.
- **Rollback (image):** redeploy the previous immutable digest (keep last N
  digests). `release:rollback` covers the npm-side tag rollback only.
- **Migrations:** because `PAPERCLIP_MIGRATION_AUTO_APPLY=true`, a bad release
  that ships a destructive migration is a risk — snapshot/backup **before**
  deploying any release that changes the schema.

### 3.7 Verify
- `curl http://<host>:3100/api/health` → `{"status":"ok",...}`
- Confirm `deploymentMode`/`exposure` in the response match intent.
- Confirm the commit stamp is the one you built (`commit` field in health).
- Smoke: create a company, assign an agent task, confirm a run lands in
  `heartbeat_run_events`.

### 3.8 Promote to public (follow-up, separate PR/effort)
1. Add TLS-terminating reverse proxy in front (set `bind=loopback` on the
   container, proxy to it).
2. Set `PAPERCLIP_DEPLOYMENT_EXPOSURE=public` + explicit HTTPS
   `PAPERCLIP_PUBLIC_URL`.
3. Confirm Better Auth rate-limiting is ON (default for public).
4. Set `PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST` only if you need local-stdio MCP;
   otherwise leave local MCP failing closed.
5. Run `pnpm paperclipai doctor` — public mode has stricter checks and will
   fail on missing hardening.

---

## 4. Decisions the operator must make (summary)
| # | Decision | Options | Recommendation (low-risk first step) |
|---|---|---|---|
| 1 | Runtime container vs bare | container / `pnpm start` | **container** (tested path) |
| 2 | DB | embedded PG on mount / external PG17 | **external PG17** (durable, restic-scoped) |
| 3 | Exposure | `private` / `public` | **`private`** now; `public` later |
| 4 | Bind | `loopback`/`lan`/`tailnet`/`custom` | **`lan`** (private) or **`loopback`+proxy** |
| 5 | Image source | build this commit / pull published | **build this commit** (deterministic) |
| 6 | Migrations | auto-apply / gate on maintainer | **auto-apply + pre-schema snapshot** |
| 7 | Telemetry | on / off / self-hosted | **on** (opt-out; company-scoped) |
| 8 | OTel | no-op / set OTLP endpoint | **no-op** unless you need distributed traces |
| 9 | LLM keys | which adapters | **Anthropic and/or OpenAI** as needed |

## 5. Out-of-scope / out-of-scope-by-default
- **Cloud warm-pool / Paperclip Cloud** (the `cloud` Docker target, `pool-*`
  origin claim flow, Ed25519 JWS activation, Sentry `@sentry/node`). This is
  multi-tenant SaaS infrastructure, not a self-hosted production deploy. Do
  not mix it in.
- **Cross-repo downstream composition** of the standard image — separate
  service.

## 6. Source anchors (where each fact comes from)
- Dev vs prod entry points: `server/package.json` (`dev`=tsx source, `start`=node dist),
  `package.json` `dev`/`dev:watch`.
- Docker production target + tini + CMD: `Dockerfile` lines 147–206.
- Entrypoint/UID-remap: `scripts/docker-entrypoint.sh`.
- Compose full-stack / quickstart: `docker/docker-compose.yml`,
  `docker/docker-compose.quickstart.yml`.
- ECS Fargate (EFS, CloudWatch, Secrets Manager, health check):
  `docker/ecs-task-definition.json`.
- Quadlet (systemd) units: `docker/quadlet/*`.
- Deployment/auth/bind model + public hardening: `doc/DEPLOYMENT-MODES.md`.
- Config/env precedence (`PAPERCLIP_*` over file config): `server/src/config.ts`.
- DB modes (`embedded-postgres` vs `postgres`, `DATABASE_URL`): `server/src/config.ts` §56,124,332.
- OTel no-op gate: `server/src/instrumentation.ts` (activates only on
  `OTEL_EXPORTER_OTLP_ENDPOINT`).
- Backup: `scripts/backup-db.sh` (`pnpm db:backup`).
- Release/rollback/registry: `scripts/release.sh`, `doc/RELEASING.md`,
  `doc/PUBLISHING.md`, `doc/DOCKER.md` (standard images + downstream composition).
- Install (managed / npx / npm): `doc/INSTALLING.md`.

## 7. What is NOT a gap (already production-ready in-tree)
- Migrations, backup scheduler, secrets local-encrypted provider, activity
  logging, single-assignee/atomic-checkout/approval-gate/budget-hard-stop
  invariants — all in `doc/SPEC-implementation.md` and enforced in
  `server/`. These carry over unchanged; the gaps are all **operational**
  (build, container, DB, secrets, exposure, backup/restore runbook), not
  code.
