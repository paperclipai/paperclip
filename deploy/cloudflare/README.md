# Paperclip on Cloudflare Sandboxes

Deploys a full Paperclip instance (npm `paperclipai`, embedded Postgres) into a
Cloudflare Sandbox container, fronted by a Worker at **https://agency.bitbuilder.dev**.

## Live URLs

| Surface | URL |
| --- | --- |
| Landing / boot page | https://agency.bitbuilder.dev |
| Paperclip control plane | https://3100-agency-main-app.bitbuilder.dev |
| Browser terminal (ghostty-web) | https://7681-agency-main-term.bitbuilder.dev |
| Worker health | https://agency.bitbuilder.dev/api/health |
| Service state (KV) | https://agency.bitbuilder.dev/api/state |
| Boot log (D1) | https://agency.bitbuilder.dev/api/log |

Preview URLs use stable `exposePort` tokens (`app`, `term`) so they are
deterministic first-level subdomains of `bitbuilder.dev` — covered by Universal
SSL without a paid wildcard cert for `*.agency.bitbuilder.dev`.

## Architecture

- **Worker** (`src/index.ts`) — `proxyToSandbox()` routes preview-URL traffic
  (HTTP + WebSocket) into the container; `/` boots services idempotently and
  renders a dual-iframe dashboard (Paperclip + terminal).
- **Sandbox container** (`container/Dockerfile`, base `cloudflare/sandbox:0.12.4`)
  - `paperclipai` (npm release) run as non-root `paperclip` user via
    `start-paperclip.sh` (embedded Postgres refuses root), onboarded
    non-interactively (`onboard --yes --bind lan`), data in `/paperclip`.
  - `opencode`, `claude` (Claude Code), and `pi` CLIs installed globally for
    use from the web terminal.
  - Browser terminal: `container/terminal/server.js` — node-pty + ws behind a
    ghostty-web frontend (coder/ghostty-web, the same approach OpenChamber
    uses: xterm.js-compatible API, WASM VT100 parser, pty bridged over a
    WebSocket).
- **Bindings**: D1 `paperclip-agency` (boot/audit log), KV
  `paperclip-agency-state` (service URLs/state), R2
  `paperclip-agency-artifacts` (artifact storage), Durable Object `Sandbox`.
- **DNS** (zone `bitbuilder.dev`, proxied A 192.0.2.1): `agency`,
  `3100-agency-main-app`, `7681-agency-main-term`, with matching Worker routes.

## Local development

```sh
cd deploy/cloudflare
npm install --legacy-peer-deps
docker build -t paperclip-agency-sandbox:local container   # sanity-check image
npx wrangler dev                                           # runs container via Docker
curl http://localhost:8787/api/boot
```

## Deploy

```sh
npx wrangler deploy
# optional: give the in-container agents an API key
npx wrangler secret put ANTHROPIC_API_KEY
```

First request to `/` (or `/api/boot`) provisions the container, onboards
Paperclip (~60-90s), and exposes both ports.

## Notes

- The zone has bot protection: curl's default UA gets blocked; use a browser
  UA when testing with curl. Browsers are unaffected.
- Paperclip runs in `authenticated` deployment mode with a pending bootstrap
  invite — open the app URL to claim the CEO/operator account.
- Container instance: 2 vCPU / 8 GiB / 10 GB disk, `max_instances: 2`.
