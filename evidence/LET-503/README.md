# LET-503 — EAOS clean Paperclip-style shell evidence package

Anchor commits on `enterprise-agent-os/LET-504` (PR #95):

| SHA | Title |
| --- | --- |
| `6f05c9f1` | `feat(ui): LET-503 rebuild EAOS as clean Paperclip-style product shell` (shell, nav, dashboard) |
| `421b70ba` | `feat(ui): LET-503 first-class org graph at /eaos/org with pan/zoom/fit + details sidebar` |
| `a3e640f4` | `feat(ui): LET-504 EAOS manual agent builder at /eaos/agents/new` |
| `b086033b` | `docs(eaos): LET-505 evidence package — route map, audits, screenshot runner` |
| `5e2f395a` | `docs(eaos): LET-505 light-theme screenshot evidence + robust runner` |
| `0553b013` | `feat(ui): LET-503 customer-friendly copy across EAOS surfaces` |
| **current head** | `feat(ui): LET-503 mock-API screenshot path + final header copy cleanup` |

PR: https://github.com/lmanualm/paperclip/pull/95

## What is in this package

| Artifact | Path | Purpose |
| --- | --- | --- |
| Route map | [`route-map.md`](./route-map.md) | Every `/eaos/*` route → component → typed API client → which counts/rows it backs. |
| No-fake-data audit | [`no-fake-data-audit.md`](./no-fake-data-audit.md) | Per-route audit of every visible count, row, badge, and tile, classifying each as real / derived / truthful-gap. **No FAIL rows.** |
| Role-gating audit | [`role-gating-audit.md`](./role-gating-audit.md) | Per-route confirmation that no operator-/admin-/destructive control is exposed to an ordinary user. **No FAIL rows.** |
| Screenshot runner | [`../../scripts/evidence/eaos-screenshots.ts`](../../scripts/evidence/eaos-screenshots.ts) | Playwright runner that drives every EAOS route through 1440×900, 1920×1080, and 1440×720 (scroll) viewports. |
| Screenshot fixtures | [`../../scripts/evidence/eaos-screenshot-fixtures.ts`](../../scripts/evidence/eaos-screenshot-fixtures.ts) | Canned API responses used ONLY by `--mock-api` mode (see below). Empty/skeleton data — no fake metrics, no fake activity. |
| Screenshot output | [`screenshots/`](./screenshots/) | 42 PNGs + `manifest.json` captured at the current branch head in light theme with `--mock-api` enabled. |
| Visual QA note | [`visual-qa-note.md`](./visual-qa-note.md) | Self-scored design review against the LET-502 contract + Paperclip/Linear reference. |

## Capture instructions (screenshots)

The Playwright runner is committed so the screenshot set is reproducible on any environment that has the dev UI running. The runner uses **only commands that ship with this repo** — no global `tsx` install is required.

Two terminals:

```bash
# Terminal 1 — start the EAOS dev UI (proxies /api to your local API server).
pnpm --filter @paperclipai/ui dev

# Terminal 2 — capture all routes in light theme with the in-process API
# mocks enabled (the default). This is what the committed PNGs use:
node cli/node_modules/tsx/dist/cli.mjs scripts/evidence/eaos-screenshots.ts \
  --base http://localhost:5173 \
  --theme light \
  --mock-api \
  --out evidence/LET-503/screenshots
```

### About `--mock-api`

`--mock-api` (default ON) installs a Playwright `context.route()` interceptor that handles every `/api/*` request with the canned fixtures in `scripts/evidence/eaos-screenshot-fixtures.ts`. The fixtures:

1. Force `/api/health` to return `deploymentMode = local_trusted` so `CloudAccessGate` does not redirect to the sign-in wall, and the actual EAOS React tree mounts.
2. Surface a single generic demo company (`Acme AI Labs`, `ACME` prefix) so `CompanyContext` can resolve. The id and name are clearly synthetic.
3. Return `[]` for every list endpoint and `{}` for every singleton endpoint that has not been pinned explicitly. This means the screenshots show authentic empty-state UI — **no fake agents, no fake missions, no decorative metrics, no fabricated activity** ever leak into evidence.

The product code is untouched; the fixtures only exist inside this runner. The manifest's top-level `"mockApi": true` flag and the per-page `"anchor-hit"` status let reviewers see exactly which routes rendered through the mock path.

### Capturing against a real backend (no mocks)

If you want to validate against a real authenticated session instead of mocks, disable the interceptor and supply a session cookie copied from your own browser tab. Do not commit the cookie:

```bash
node cli/node_modules/tsx/dist/cli.mjs scripts/evidence/eaos-screenshots.ts \
  --base http://localhost:5173 \
  --theme light \
  --no-mock-api \
  --cookie '__Secure-paperclip-default.session_token=...' \
  --out evidence/LET-503/screenshots
```

### Notable flags

- `--theme light|dark` (default `light`) writes `paperclip.theme` into `localStorage` via `addInitScript` before the React app mounts, so the captured surfaces match the LET-502 light-first design contract.
- `--anchor-timeout <ms>` (default `8000`) controls how long the runner waits for each route's primary `data-testid` anchor before recording the screenshot as `truthful-gap`.
- The runner **always completes successfully**: if a route's anchor or stepper button is not visible, it captures whatever is on screen, records the state as `truthful-gap` in `manifest.json`, and moves on. It never times out the entire run on a single missing selector.

Output:

- `evidence/LET-503/screenshots/1440/<route>.png` — desktop 1440×900.
- `evidence/LET-503/screenshots/1920/<route>.png` — wide 1920×1080.
- `evidence/LET-503/screenshots/scroll/<route>.png` — 1440×720 scrolled to bottom (scroll-proof shot).
- `evidence/LET-503/screenshots/manifest.json` — per-route capture status (`anchor-hit`, `truthful-gap`, `error`) including the substep / note / mock flag for each PNG.

## Captured states (what the committed PNGs actually show)

The committed `screenshots/` set was captured with `--mock-api --theme light` at the current branch head. Every product route reached `anchor-hit`; there are no `error` or `truthful-gap` rows for the required design gate. The PNGs render the actual EAOS UI shell + page chrome with truthful empty states (no agents, no missions, no projects, no runs, no approvals seeded — these are the real "brand-new install" empty surfaces).

If a reviewer wants to validate the authenticated-user path against real backend data, the `--no-mock-api` / `--cookie` variant above produces a parallel set without changing committed code or evidence.

## Hard gates respected

- No deploy, no service restart, no production DB migration apply, no protected-branch merge.
- No spend, no live vendor enablement.
- No raw secrets in any file under `evidence/LET-503/`. The fixtures contain only synthetic identifiers; the Playwright runner does not write headers/cookies into PNG metadata; user-visible strings are still redacted by `secret-redact.ts` at the React layer before render.
