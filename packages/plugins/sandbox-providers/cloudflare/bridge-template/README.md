# Cloudflare Sandbox Bridge Template

This Worker is the operator-facing bridge used by `@paperclipai/plugin-cloudflare-sandbox`.

It exposes a small authenticated JSON API under `/api/paperclip-sandbox/v1` and translates Paperclip lease and command requests into Cloudflare Sandbox SDK calls.

## What it does

- health and probe
- acquire, resume, release, and destroy leases
- execute commands in a sandbox session
- clean up timed-out sessions so Paperclip does not inherit wedged background processes

## Prerequisites

1. Cloudflare account with Sandbox / Containers access
2. `wrangler` configured for that account
3. Docker running locally for `wrangler deploy`
4. A bridge auth token set as a Worker secret:

```bash
npx wrangler secret put BRIDGE_AUTH_TOKEN
```

## Local development

```bash
cd bridge-template
pnpm install --ignore-workspace --no-lockfile
pnpm test
pnpm typecheck
pnpm dev
```

## Deploy

```bash
pnpm deploy
```

After deploy, configure Paperclip with:

- `bridgeBaseUrl`: your Worker URL
- `bridgeAuthToken`: the same bearer token value stored in `BRIDGE_AUTH_TOKEN`

## Notes

- `reuseLease: true` should only be used together with `keepAlive: true`
- `.workers.dev` is fine for bridge HTTP traffic, but preview/wildcard host flows are intentionally out of scope here
- keep the Docker image aligned with the installed `@cloudflare/sandbox` version
