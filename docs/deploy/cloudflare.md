---
title: Cloudflare
summary: Run Paperclip on Cloudflare Workers with a Sandbox container
---

Deploy a full Paperclip instance to Cloudflare: a Worker proxies your
`*.workers.dev` origin into a [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/)
container that runs `paperclipai` (npm release) with embedded Postgres and the
local-adapter agent CLIs (Claude Code, Codex, OpenCode, Gemini) preinstalled.

No custom domain is required — HTTP and WebSocket traffic are proxied on the
Worker's own origin.

## ⚠️ Data Durability

**Sandbox container disk is ephemeral.** When the container sleeps after
inactivity or is replaced by a deploy, the embedded Postgres data directory is
wiped — companies, agents, issues, everything.

Treat the default configuration as an **evaluation deployment**. For anything
you want to keep, point Paperclip at an external Postgres before onboarding:

```sh
npx wrangler secret put DATABASE_URL
# e.g. postgres://USER:PASSWORD@HOST:5432/paperclip  (Neon, Supabase, RDS, …)
```

The Worker forwards `DATABASE_URL` into the container and Paperclip uses it
instead of embedded Postgres.

## Durable Attachments via R2 (Optional, Experimental)

> **Experimental:** this mount path is newer than the rest of the deployment
> and has not yet been validated on a live deployment. The default (no R2
> binding) is unaffected.

Uploaded files (issue attachments, images) can survive container recycling
without any Paperclip configuration: the Worker FUSE-mounts an R2 bucket at
Paperclip's [local-disk storage directory](/deploy/storage) before boot,
credential-less, through the Worker's own R2 binding.

```sh
npx wrangler r2 bucket create paperclip-attachments
# then uncomment the r2_buckets block in wrangler.jsonc and redeploy
```

Notes:

- Only the attachments directory is mounted. The Postgres data directory
  stays on container disk **by design** — databases must not run on FUSE
  mounts. Durable attachments complement, not replace, `DATABASE_URL`.
- In `wrangler dev` the SDK syncs the directory through the R2 binding
  instead of s3fs; behavior is equivalent for testing.
- Alternatively, Paperclip's own `s3` storage provider can talk to R2
  directly via its S3-compatible API (`paperclipai configure --section
  storage`) — the mount is just the zero-config path.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan (containers are not
  available on the free tier)
- [Docker](https://docs.docker.com/get-docker/) running locally (wrangler
  builds the container image and, for `wrangler dev`, runs it)
- Node.js 22+ (required by the pinned wrangler toolchain) and pnpm

## Deploy

```sh
cd deploy/cloudflare
pnpm install
npx wrangler login
npx wrangler deploy

# required before anything is served: gate the deployment until you claim
# the operator account — any value you choose, e.g. `openssl rand -hex 16`
npx wrangler secret put BOOTSTRAP_TOKEN

# optional: give in-container agents an API key
npx wrangler secret put ANTHROPIC_API_KEY
```

Then open
`https://paperclip-sandbox.<your-subdomain>.workers.dev/?bootstrap_token=<your token>`.
The **first request** provisions the container and onboards Paperclip
(a minute or two) — you'll see a self-refreshing status page until the app is
up.

Paperclip boots in `authenticated` mode with a pending bootstrap invite, and
**the first visitor to reach the app can claim the operator account**. The
deployment is therefore **fail-closed**: until `BOOTSTRAP_TOKEN` is set, the
Worker serves only a setup page, and with the token set, requests must
present it (query param once; cookie afterwards) or receive a 401 — nothing
reaches Paperclip either way.

After you claim the operator account, open the deployment to your team by
setting `DISABLE_BOOTSTRAP_GATE` to `"true"` in `wrangler.jsonc` and
redeploying — from that point Paperclip's own login protects everything.

## Configuration

Set via `vars` in `wrangler.jsonc` or `wrangler secret put`:

| Name | Kind | Default | Purpose |
| --- | --- | --- | --- |
| `PAPERCLIP_PUBLIC_URL` | var | request origin | Public URL Paperclip advertises |
| `PAPERCLIP_DEPLOYMENT_MODE` | var | `authenticated` | See [Deployment Modes](/deploy/deployment-modes) |
| `PAPERCLIP_DEPLOYMENT_EXPOSURE` | var | `private` | Embedded Postgres currently requires `private`; use `public` only with an external `DATABASE_URL` |
| `BOOTSTRAP_TOKEN` | secret | — (required) | Fail-closed gate: nothing is served until set (see Deploy) |
| `DISABLE_BOOTSTRAP_GATE` | var | `"false"` | Set `"true"` after claiming the operator account to open team logins |
| `ANTHROPIC_API_KEY` | secret | — | Forwarded to in-container agent CLIs |
| `DATABASE_URL` | secret | — | External Postgres (strongly recommended, see above) |
| `ARTIFACTS` | R2 binding | — | Durable attachment storage (see above) |

Container sizing lives in `wrangler.jsonc` (`instance_type`, default
2 vCPU / 8 GiB / 10 GB). Embedded Postgres plus concurrent agent processes
want real memory; shrink with care.

## How It Works

- `src/index.ts` — Worker entry. On each request it idempotently ensures the
  Paperclip boot process is running (`sandbox.startProcess`), then proxies:
  WebSocket upgrades via `sandbox.wsConnect(request, 3100)`, everything else
  via `sandbox.containerFetch(request, 3100)`. Same-origin proxying keeps
  Paperclip's cookies and live-update WebSockets on one host.
- `container/Dockerfile` — extends `cloudflare/sandbox` (tag pinned to the
  `@cloudflare/sandbox` package version; enforced by `test/config.test.ts`),
  installs `paperclipai` and the agent CLIs.
- `container/start-paperclip.sh` — onboards once
  (`paperclipai onboard --yes --bind lan`), then `paperclipai run`, as a
  non-root user (embedded Postgres refuses root).

## Local Development

```sh
cd deploy/cloudflare
pnpm install
pnpm dev            # wrangler dev — builds and runs the container via Docker
```

Run the unit and config-consistency tests:

```sh
pnpm test
pnpm typecheck
```

## Troubleshooting

- **Status page loops for more than ~5 minutes** — check `npx wrangler tail`
  for container/start errors. First-ever deploys can also spend a few minutes
  provisioning container capacity.
- **`Container is currently provisioning`** in logs is normal on first boot.
- **Everything reset after idling** — that's the ephemerality caveat above;
  configure `DATABASE_URL`.
- **Inspect the container directly** — `npx wrangler dev` locally, then
  `docker exec` into the running container; or add temporary debug output to
  `start-paperclip.sh`.

## Cost Notes

You pay for Worker requests plus container runtime (vCPU-seconds, memory,
disk) while the sandbox is awake. The container sleeps after inactivity;
with embedded Postgres that also means data loss (see above), which is the
other reason to use an external database.
