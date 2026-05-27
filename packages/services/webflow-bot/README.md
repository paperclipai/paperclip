# webflow-bot

Long-running [Camoufox](https://github.com/daijro/camoufox) session that holds
an authenticated Webflow Designer with the "Webflow MCP Bridge App" launched,
exposing an HTTP control plane on port 7000 for cluster agents to drive
Designer ops (screenshot, eval, click, set_html_embed, …).

Replaces the Node+Chromium implementation that got PX-challenged on every
navigation. Camoufox's binary-level fingerprint randomization passes the
Cloudflare PX challenge both on initial login and on sustained browsing.

## Architecture

Single-identity service (in contrast to the multi-identity figma-bot). One
Camoufox profile, one Webflow account, persistent storage on a cluster PVC.

```
┌────────────────────── pod ──────────────────────┐
│  Xvfb :99   ←   x11vnc :5900 → websockify :6080 (noVNC)
│       ↑
│  Camoufox (Firefox) — webflow.com/designer/...
│       ↑                       ↓ (Playwright)
│       └────────── webflow-bot.py ──────────────→ HTTP :7000
└─────────────────────────────────────────────────┘
```

## HTTP control plane (`:7000`)

All endpoints require `X-Control-Token` header.

| Method | Path | Body / params | Returns |
|---|---|---|---|
| GET | `/health` | — | `{logged_in, url, phase}` |
| POST | `/screenshot` | `{ fullPage? }` | `image/png` |
| POST | `/eval` | `{ code }` | result of `page.evaluate(code)` |
| POST | `/key` | `{ key }` | OK |
| POST | `/click` | `{ x, y }` | OK |
| POST | `/dblclick` | `{ x, y }` | OK |
| POST | `/drag` | `{ from, to, … }` | OK |
| POST | `/selector_click` | `{ selector }` | OK |
| POST | `/set_html_embed` | `{ value, aid? }` | OK |
| POST | `/create_page` | `{ name, slug, … }` | OK |

## Local development

```bash
cd packages/services/webflow-bot
pip install -e ".[dev]"
pytest tests/
ruff check src/ tests/
mypy src/
```

## Local build

```bash
# From the paperclip monorepo root:
docker buildx build -f packages/services/webflow-bot/Dockerfile -t webflow-bot:dev .
```

## Deploy

Image is built + pushed to Harbor by
`paperclip/.github/workflows/docker-webflow-bot.yml` on every merge to master.
Cluster deployment yaml lives in
`onprem-k8s/paperclip/webflow-designer-bot.yaml`; cutover to a new image tag
is an explicit operator step (no auto-deploy).

## History

Migrated from `onprem-k8s/.planning/webflow-designer-bot-image/` +
`onprem-k8s/paperclip/webflow-designer-bot.yaml` (ConfigMap-embedded Python)
as part of BLO-6870 — extracts services from cluster yaml into the monorepo
where they can be tested + reviewed + version-controlled like every other
paperclip code.
