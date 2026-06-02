# Plan: ValAdrien Cloud — Blitz go-live checklist + hosted URL

**Status:** Active planning (2026-06-02)  
**Owner:** Platform / ValAdrien.DEV operator  
**Related:**

- `doc/plans/2026-06-02-host-valadrien-vercel-supabase-walkthrough.md` (**use this:** GitHub → Vercel → Supabase, step by step)
- `doc/plans/2026-06-02-railway-walkthrough-host-valadrien.md` (superseded for main app — Railway workers only)
- `doc/plans/2026-06-01-valadrien-cloud-managed-infra.md` (Phases 0–5)
- `Architecture.md` §13 (Tenancy / ValAdrien.DEV bootstrap)
- `docs/deploy/overview.md`, `docs/deploy/environment-variables.md`, `docs/deploy/database.md`
- `docs/deploy/aws-ecs.md` (full production on AWS)
- `docs/deploy/docker.md` (container image)

## Why this doc exists

1. **Go / no-go** — Separate “dogfood ValAdrien.DEV” from “first paying client tenant” without waiting for every Phase 3–5 item.
2. **Blitz cadence** — Optimize for **days and parallel tracks**, not “finish everything then add companies.”
3. **Hosted URL** — Run the control plane on a server so your laptop is not holding embedded Postgres + watchers (memory pressure).

---

## Part A — Blitz sequencing (companies vs platform)

ValAdrien OS is **single-instance, multi-company** (`Architecture.md` §13). The operator company (ValAdrien.DEV) is one `companies` row; **client companies are more rows**, not a second product. You do **not** need to “finish the whole OS” before a second company exists in dev or staging.


| Track                          | Goal                                                                          | Block first **client**? | Block **dogfood**?                      |
| ------------------------------ | ----------------------------------------------------------------------------- | ----------------------- | --------------------------------------- |
| **Instance**                   | Hosted Postgres, public URL, auth, secrets master key, `VALADRIEN_OS_API_URL` | Yes                     | Yes for “URL not laptop”                |
| **ValAdrien.DEV company**      | Onboarding wizard done, founding agents working, entitlements visible         | No                      | Yes for credible operator story         |
| **ValAdrien Cloud Phases 0–2** | Entitlements + CEO truth + optional website/founder URLs                      | No                      | Largely done                            |
| **Phase 3**                    | Lazy provisioning → real bindings on first use                                | Prefer before client    | Optional if you hand-bind ValAdrien.DEV |
| **Phase 4**                    | Budget envelope vs per-service approvals                                      | Prefer before client    | Optional short-term                     |
| **Phase 5**                    | Export / BYO                                                                  | No until handoff        | No                                      |


### Blitz rules (late / high throughput)

1. **Parallelize:** Instance deploy (URL + DB) in parallel with product PRs; do not serialize “code complete → then deploy.”
2. **One canonical tenant:** ValAdrien.DEV remains the reference company for valadrien-os work; add **test / side** companies only when they reduce risk (onboarding regression, multi-tenant queries).
3. **Clients last:** First **external** client company after: hosted instance + `DATABASE_URL` + auth + at least one of: Phase 3 provisioning **or** a written runbook for operator-bound secrets for that client.
4. **Timebox decisions:** If a Phase 3 adapter slips, ship **manual binding** for ValAdrien.DEV only and keep client timeline honest.

---

## Part B — Go / no-go gates (explicit)

### Gate 1 — “I can use ValAdrien OS from a browser without `pnpm dev` on my Mac”


| Check     | Pass criteria                                                                        |
| --------- | ------------------------------------------------------------------------------------ |
| HTTPS URL | You open `https://…` and load the board                                              |
| Postgres  | `DATABASE_URL` is real Postgres (Supabase or RDS), **not** embedded PG on the laptop |
| Auth      | `authenticated` + `public` with explicit public base URL (see Part C)                |
| API base  | `VALADRIEN_OS_API_URL` matches the public origin agents/UI use                       |
| Secrets   | `VALADRIEN_OS_SECRETS_MASTER_KEY` (or file) set on the host; backed up once          |


### Gate 2 — “ValAdrien.DEV is the operator dogfood tenant”


| Check            | Pass criteria                                                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Company exists   | ValAdrien.DEV onboarded; you are `owner` + `instance_admin` per §13                                         |
| Entitlements     | `GET /api/companies/{id}/infra-entitlements` returns the default five rows for managed                      |
| Founding loop    | CEO heartbeat runs without requesting board approval for “buy Supabase/Vercel” for **managed** capabilities |
| Optional context | `website_url` / `founder_url` set if you want first-issue enrichment                                        |


### Gate 3 — “First client company (external)”


| Check           | Pass criteria                                                                     |
| --------------- | --------------------------------------------------------------------------------- |
| Contract        | Who pays for overage; support channel; data residency if any                      |
| Isolation story | Shared pool + company scope **or** dedicated row modes documented for that client |
| Provisioning    | Phase 3 live **or** operator runbook + checklist completed once in staging        |
| Budget          | Phase 4 live **or** manual budget approval workflow you accept for v1             |
| Handoff         | Export path understood (Phase 5), even if “manual for v1”                         |


---

## Part C — Attach to a URL (hosted control plane)

**Constraint (from server):** `authenticated` + `public` **refuses** embedded PostgreSQL. You **must** set a Postgres `DATABASE_URL` (e.g. Supabase). See `server/src/index.ts` startup checks.

### C.1 Fastest paths (pick one)


| Path                             | When to use                                                                                                                | Tradeoff                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **A. Managed PaaS + Dockerfile** | Blitz: Fly.io, Railway, Render, Google Cloud Run — build repo `Dockerfile`, set env, attach volume or use external DB only | You own TLS + env discipline; smaller blast radius than full AWS |
| **B. AWS ECS + RDS + ALB**       | “Production-shaped” from day one                                                                                           | More setup; follow `docs/deploy/aws-ecs.md` end-to-end           |
| **C. Small VM + Docker Compose** | Cheapest mental model                                                                                                      | You patch OS, Caddy/nginx for TLS, backups                       |


**Not recommended for “URL not laptop”:** Running `pnpm dev` on the Mac with Tailscale only — still local memory.

### C.2 Environment minimum (public deployment)

Set on the **server host** (platform secrets, not in git):

1. `DATABASE_URL` — Supabase **direct** (5432) for migrations; **pooled** (6543) with `prepare: false` for app if your client supports it (`docs/deploy/database.md`).
2. `VALADRIEN_OS_DEPLOYMENT_MODE=authenticated`
3. `VALADRIEN_OS_DEPLOYMENT_EXPOSURE=public`
4. `VALADRIEN_OS_API_URL=https://your-host.example` (must match browser origin)
5. **Public auth URL** — for `authenticated` + `public`, set explicit base URL via env (see `server/src/config.ts`):
  - `VALADRIEN_OS_AUTH_BASE_URL_MODE=explicit`  
  - `VALADRIEN_OS_AUTH_PUBLIC_BASE_URL=https://your-host.example` (or `BETTER_AUTH_URL` / `BETTER_AUTH_BASE_URL` / `VALADRIEN_OS_PUBLIC_URL` — same effective field)  
   Use `pnpm valadrien-os configure --section server` locally once if you want to mirror the JSON config; production should set the env vars on the host.
6. `VALADRIEN_OS_SECRETS_MASTER_KEY` — generate once; store in vault; **backup** before first real data.
7. OAuth / Better Auth secrets as required by your auth provider (see `docs/deploy/aws-ecs.md` for `AUTH_SECRET` pattern on AWS; mirror for other hosts).

Then run `**valadrien-os doctor`** (or health endpoint) from the deployment per `doc/SECRETS-AWS-PROVIDER.md` / deploy docs.

### C.3 Build & run (container)

```sh
# From repo root — build image
docker build -t valadrien-os-server .

# Run (example; inject real env via your platform)
docker run -d --name valadrien-os -p 3100:3100 \
  -e DATABASE_URL="postgres://..." \
  -e VALADRIEN_OS_DEPLOYMENT_MODE=authenticated \
  -e VALADRIEN_OS_DEPLOYMENT_EXPOSURE=public \
  -e VALADRIEN_OS_API_URL="https://your-host.example" \
  # … auth + secrets …
  valadrien-os-server
```

Compose reference: `docs/deploy/docker.md` (`docker/docker-compose.quickstart.yml` defaults to local port; put the same container behind HTTPS on a host).

### C.4 TLS

- **PaaS:** Let the platform terminate TLS (simplest).
- **VM:** Caddy or nginx + Let’s Encrypt in front of port 3100.
- **ECS:** ALB + ACM per `docs/deploy/aws-ecs.md`.

### C.5 Migrations

After `DATABASE_URL` points at empty or new Postgres, apply migrations using the repo’s documented path (`pnpm db:generate` / migrate in CI or a one-off job). Do **not** import old `management-os` Supabase schema into this DB (salvage decision).

### C.6 Cutover from `os.valadrien.dev` (when ready)

Point DNS / Vercel project (or ALB) at the new service; lower TTL first; smoke-test login + create issue + agent API. Keep old instance read-only until you confirm export path or discard.

---

## Part D — Day-zero checklist (blitz, ordered)

Use this as a single execution list; tick in place.

- **D1** — New Supabase (or RDS) project; `DATABASE_URL` in vault  
- **D2** — Build/push `Dockerfile` to chosen host  
- **D3** — Env: `authenticated` + `public` + `VALADRIEN_OS_API_URL` + auth explicit public base URL  
- **D4** — Secrets master key generated and backed up  
- **D5** — Migrations applied; health + login works  
- **D6** — Onboard ValAdrien.DEV; confirm infra-entitlements endpoint  
- **D7** — Run migration **0091** (or equivalent) on hosted DB so pre-0090 companies get rows  
- **D8** — (Parallel) Phase 3 spike OR operator runbook for manual bindings  
- **D9** — First **non-operator** test company on **staging** only  
- **D10** — First client company only after Gate 3

---

## Open items (track explicitly)

- OAuth / social provider client IDs and callback URLs registered for the **public** hostname (GitHub/Google/etc. as you use).
- CI job: build image + migrate on deploy branch.
- Staging subdomain vs production subdomain policy.

---

## Model used

None — human-authored plan structure; repo paths and server constraints verified against codebase search (2026-06-02).