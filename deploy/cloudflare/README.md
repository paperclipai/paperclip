# Paperclip on Cloudflare

Deploys a full Paperclip instance to Cloudflare Workers: the Worker proxies
your `*.workers.dev` origin (HTTP + WebSockets) into a
[Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) container
running `paperclipai` with embedded Postgres and the local-adapter agent CLIs
preinstalled. No custom domain required.

```sh
pnpm install
npx wrangler login
npx wrangler deploy
npx wrangler secret put BOOTSTRAP_TOKEN   # required — deployment is fail-closed until set
```

> ⚠️ Container disk is **ephemeral** — for any data you want to keep, set an
> external database first (`npx wrangler secret put DATABASE_URL`) and
> optionally enable the R2 attachments mount (see `wrangler.jsonc`).

Full operator guide (prerequisites, configuration, durability, costs,
troubleshooting): **[docs/deploy/cloudflare.md](../../docs/deploy/cloudflare.md)**.

## Layout

| Path | Purpose |
| --- | --- |
| `src/index.ts` | Worker: boots Paperclip in the sandbox, proxies HTTP + WS |
| `src/lib.ts` | Pure helpers (unit-tested) |
| `container/Dockerfile` | Sandbox image: paperclipai + agent CLIs |
| `container/start-paperclip.sh` | Onboard-once boot script (non-root) |
| `wrangler.jsonc` | Worker + container + Durable Object config |
| `test/` | Unit tests + cross-file config consistency checks |

This package is intentionally **not** part of the root pnpm workspace (same
pattern as `packages/plugins/sandbox-providers/*`) — its own
`pnpm-workspace.yaml` makes it a standalone single-package workspace, so the
Cloudflare toolchain never churns the root lockfile and a plain
`pnpm install` here does the right thing.

```sh
pnpm test        # vitest: lib + config invariants (Dockerfile↔SDK version pin)
pnpm typecheck
```
