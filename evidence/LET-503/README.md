# LET-503 — EAOS clean Paperclip-style shell evidence package

Anchor commits:

- `6f05c9f1` — `feat(ui): LET-503 rebuild EAOS as clean Paperclip-style product shell` (shell, nav, posture, Dashboard).
- `421b70ba` — `feat(ui): LET-503 first-class org graph at /eaos/org with pan/zoom/fit + details sidebar`.
- `a3e640f4` — `feat(ui): LET-504 EAOS manual agent builder at /eaos/agents/new` (linked continuation of LET-503 per reviewer note).
- `b086033b` — `docs(eaos): LET-505 evidence package — route map, audits, screenshot runner` (this evidence dir originated here).

Branch head when this package was regenerated: `b086033b` on `enterprise-agent-os/LET-504`.
PR: https://github.com/lmanualm/paperclip/pull/95 (continues with the LET-504 commit; branch `enterprise-agent-os/LET-504` carries the bundled state).

## What is in this package

| Artifact | Path | Purpose |
| --- | --- | --- |
| Route map | [`route-map.md`](./route-map.md) | Every `/eaos/*` route → component → typed API client → which counts/rows it backs. Includes the truthful-gap labels surfaced inline. |
| No-fake-data audit | [`no-fake-data-audit.md`](./no-fake-data-audit.md) | Per-route audit of every visible count, row, badge, and tile, classifying each as real / derived / truthful-gap. **No FAIL rows.** |
| Role-gating audit | [`role-gating-audit.md`](./role-gating-audit.md) | Per-route confirmation that no operator-/admin-/destructive control is exposed to an ordinary user. Lists escape-hatch links explicitly. **No FAIL rows.** |
| Screenshot runner | [`../../scripts/evidence/eaos-screenshots.ts`](../../scripts/evidence/eaos-screenshots.ts) | Playwright runner that drives the EAOS dev UI through 1440×900, 1920×1080, and 1440×720 (scroll) viewports, capturing PNGs per route under `screenshots/<viewport>/<route>.png` and a `manifest.json` describing per-capture status. |
| Screenshot output (unauth, light) | [`screenshots/`](./screenshots/) | 32 PNGs + `manifest.json` captured against the LET-504 branch dev UI in light theme without a session cookie. See "Captured states" below. |

## Capture instructions (screenshots)

The Playwright runner is committed so the screenshot set can be reproduced on any environment with the dev UI running. The runner uses **only commands that ship with this repo** — no global `tsx` install is required.

Two terminals:

```bash
# Terminal 1 — start the EAOS dev UI (proxies /api to your control plane).
pnpm --filter @paperclipai/ui dev

# Terminal 2 — capture all routes in light theme, repo-available command:
node cli/node_modules/tsx/dist/cli.mjs scripts/evidence/eaos-screenshots.ts \
  --base http://localhost:5173 \
  --theme light \
  --out evidence/LET-503/screenshots

# Optional — supply a session cookie from an authenticated browser tab to
# capture the EAOS surfaces as a user with company access would see them:
node cli/node_modules/tsx/dist/cli.mjs scripts/evidence/eaos-screenshots.ts \
  --base http://localhost:5173 \
  --theme light \
  --cookie '__Secure-paperclip-default.session_token=...' \
  --out evidence/LET-503/screenshots
```

Notable flags:

- `--theme light|dark` (default `light`) writes `paperclip.theme` into `localStorage` via `addInitScript` before the React app mounts, so the captured surfaces match the LET-502 light-first design contract even though `ui/index.html` still ships a dark fallback for non-EAOS surfaces.
- `--anchor-timeout <ms>` controls how long the runner waits for each route's primary `data-testid` anchor before recording the screenshot as `truthful-gap`. Default 8000 ms.
- The runner **always completes successfully**: if a route's anchor or stepper button is not visible, it captures the current viewport, records the state as `truthful-gap` in `manifest.json`, and continues. It never times out the run on a single missing selector.

Output:

- `evidence/LET-503/screenshots/1440/<route>.png` — desktop 1440×900.
- `evidence/LET-503/screenshots/1920/<route>.png` — wide 1920×1080.
- `evidence/LET-503/screenshots/scroll/<route>.png` — 1440×720 scrolled to bottom (scroll-proof shot).
- `evidence/LET-503/screenshots/manifest.json` — per-route capture status (`anchor-hit`, `truthful-gap`, `error`) including the substep / note for each PNG.

The runner is intentionally read-only: it navigates each EAOS primary-nav route, waits for the `data-testid` anchor, optionally clicks through the `/eaos/agents/new` stepper when the anchor is visible, and snapshots. No live action, no vendor traffic, no API mutation.

## Captured states (what the committed PNGs actually show)

The committed `screenshots/` set was captured against the LET-504 branch dev UI **without a session cookie**, in light theme. Because this Paperclip instance is in `deploymentMode = authenticated`, `CloudAccessGate` redirects unauthenticated traffic to `/auth`. Every PNG therefore shows the **light-theme sign-in wall** for the requested route — that is the truthful gap state for an unauthenticated reviewer.

This is acceptable LET-505 evidence per the LET-503 review criteria ("genuinely completes unauthenticated with truthful gap screenshots without timing out on builder substeps"). The companion `manifest.json` records `status = truthful-gap` and the exact anchor selector that did not appear, so reviewers can tell at a glance which PNGs require an authenticated re-capture to inspect the EAOS surface itself.

To capture the authenticated EAOS surfaces, run the optional cookie variant above with a fresh `paperclip-session` (or `__Secure-paperclip-default.session_token`) cookie copied from a browser tab that already belongs to a company on this instance. The runner re-applies the cookie per page and writes the new `manifest.json` with `status = anchor-hit` for every route whose primary anchor renders.

## Hard gates respected

- No deploy, no service restart, no production DB migration apply, no protected-branch merge.
- No spend, no live vendor enablement.
- No raw secrets in any file under `evidence/LET-503/`. The Playwright runner does not write headers/cookies into PNG metadata; user-visible strings are still redacted by `secret-redact.ts` at the React layer before render.
