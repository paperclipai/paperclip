# figma-bot

Multi-identity [Camoufox](https://github.com/daijro/camoufox) session that
holds authenticated Figma Designer pages, exposing an HTTP control plane
on port 7000 for cluster agents to drive design ops (variant generation,
component import, design-system sync, …).

Unlike the sibling `webflow-bot`, figma-bot supports multiple identities
in a single pod via a lease + identity-registry mechanism, switching the
active Camoufox profile between them on demand. See
`docs/runbooks/figma-bot-multi-profile-smoke.md` in `onprem-k8s` for the
14 smoke cases that exercise this surface.

## Architecture (multi-profile)

```
┌──────────────── pod ────────────────┐
│  Xvfb :99  ←  x11vnc :5900  →  noVNC :6080
│       ↑                      ↓ (lease control)
│  Camoufox (one identity at a time)
│       ↑                      ↓ (Playwright)
│       └─ figma-bot/__main__.py ──→ HTTP :7000
│                              ↓
│  identity registry (loaded from
│   paperclip-figma-bot-identities)
└─────────────────────────────────────┘
```

## HTTP control plane (`:7000`)

All endpoints require `X-Control-Token` header. Interaction endpoints
also require `X-Lease-Id`.

| Method | Path | Body / params |
|---|---|---|
| GET | `/health` | — (returns lease + identity snapshot) |
| GET | `/lease/status` | — |
| POST | `/lease/acquire` | `{ client_id, identity?, ttl?, force_refresh? }` |
| POST | `/lease/release` | `X-Lease-Id` |
| POST | `/lease/heartbeat` | `X-Lease-Id` |
| POST | `/screenshot` | `X-Lease-Id` |
| POST | `/eval` | `{ expression }`, `X-Lease-Id` |

## Notable bugfix shipped with the migration

The cluster's previous v0.3 of figma-bot (PR #306 in onprem-k8s) shipped
through 14 commits in a ConfigMap with no test surface and contained a
cold-bootstrap chicken-and-egg bug:

> `/lease/acquire` → `_submit_switch_job` → puts a `_SwitchSentinel` on
> `_job_queue` → waits 60s on a `threading.Event`. The main loop is the
> only consumer of the queue (via `_drain_jobs_for`), but that only fires
> after `pm` is built. `pm` is only built after `_active_target` is set,
> which is only set by the queue drain. Cold boots therefore deadlock
> until the 60s timeout fires "switch_timeout" on every first acquire.

The fix lands in this extraction at `__main__.py:main()`: set
`_active_target` to the default identity BEFORE entering the loop. See
`tests/test_cold_boot.py` for the regression gate.

## Local development

```bash
cd packages/services/figma-bot
pip install pytest ruff
python -m pytest tests/
ruff check src/ tests/
```

## Local build

```bash
# From the paperclip monorepo root, after the webflow-bot image exists:
docker buildx build -f packages/services/figma-bot/Dockerfile -t figma-bot:dev .
```

## Deploy

Image is built + pushed to Harbor by
`paperclip/.github/workflows/docker-figma-bot.yml` on every merge to
master. Cluster deployment yaml lives in
`onprem-k8s/paperclip/figma-designer-bot.yaml`; cutover to a new image
tag is an explicit operator step (no auto-deploy).

## History

Migrated from `onprem-k8s/paperclip/figma-designer-bot.yaml`
(ConfigMap-embedded Python) as part of BLO-6870. Original ConfigMap was
1250 lines (including the chicken-and-egg bug that production hit).
