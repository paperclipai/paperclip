# LET-503 — EAOS clean Paperclip-style shell evidence package

Anchor commits:

- `6f05c9f1` — `feat(ui): LET-503 rebuild EAOS as clean Paperclip-style product shell` (shell, nav, posture, Dashboard).
- `421b70ba` — `feat(ui): LET-503 first-class org graph at /eaos/org with pan/zoom/fit + details sidebar`.
- `a3e640f4` — `feat(ui): LET-504 EAOS manual agent builder at /eaos/agents/new` (linked continuation of LET-503 per reviewer note).

PR: https://github.com/lmanualm/paperclip/pull/95 (continues with the LET-504 commit; branch `enterprise-agent-os/LET-504` carries the bundled state).

## What is in this package

| Artifact | Path | Purpose |
| --- | --- | --- |
| Route map | [`route-map.md`](./route-map.md) | Every `/eaos/*` route → component → typed API client → which counts/rows it backs. Includes the truthful-gap labels surfaced inline. |
| No-fake-data audit | [`no-fake-data-audit.md`](./no-fake-data-audit.md) | Per-route audit of every visible count, row, badge, and tile, classifying each as real / derived / truthful-gap. **No FAIL rows.** |
| Role-gating audit | [`role-gating-audit.md`](./role-gating-audit.md) | Per-route confirmation that no operator-/admin-/destructive control is exposed to an ordinary user. Lists escape-hatch links explicitly. **No FAIL rows.** |
| Screenshot runner | [`../../scripts/evidence/eaos-screenshots.ts`](../../scripts/evidence/eaos-screenshots.ts) | Playwright runner that drives the EAOS dev UI through 1440×900, 1920×1080, and 1440×720 (scroll) viewports, capturing PNGs per route under `screenshots/<viewport>/<route>.png`. |
| Screenshot output | [`screenshots/`](./screenshots/) | Empty placeholders (`1440/`, `1920/`, `scroll/`) ready for the runner to populate. See "Capture instructions" below. |

## Capture instructions (screenshots)

The Playwright runner is committed so the screenshot set can be reproduced on any environment with the dev UI running. Two terminals:

```bash
# Terminal 1 — start the EAOS dev UI (proxies /api to your control plane).
pnpm --filter @paperclipai/ui dev

# Terminal 2 — get a paperclip-session cookie from a browser tab that is
# authenticated against the proxied control plane, then run the capture:
tsx scripts/evidence/eaos-screenshots.ts \
  --base http://localhost:5173 \
  --cookie 'paperclip-session=...' \
  --out evidence/LET-503/screenshots
```

Output:

- `evidence/LET-503/screenshots/1440/<route>.png` — desktop 1440×900.
- `evidence/LET-503/screenshots/1920/<route>.png` — wide 1920×1080.
- `evidence/LET-503/screenshots/scroll/<route>.png` — 1440×720 scrolled to bottom (scroll-proof shot).

The runner is intentionally read-only: it navigates each EAOS primary-nav route, waits for the `data-testid` anchor, optionally clicks through the `/eaos/agents/new` stepper, and snapshots. No live action, no vendor traffic, no API mutation.

Why screenshots are not pre-baked into this commit: the local heartbeat that produced the evidence package only had access to the older deployed release backend on `localhost:3100` (deploymentMode `authenticated`); pre-baking screenshots from there would have meant injecting a session cookie that is operator-scoped, and would have shown an older release commit's UI rather than the LET-503 / LET-504 branch state. The runner produces reviewer-environment-faithful screenshots when run against the branch head's dev UI.

## Hard gates respected

- No deploy, no service restart, no production DB migration apply, no protected-branch merge.
- No spend, no live vendor enablement.
- No raw secrets in any file under `evidence/LET-503/`. The Playwright runner does not write headers/cookies into PNG metadata; user-visible strings are still redacted by `secret-redact.ts` at the React layer before render.
