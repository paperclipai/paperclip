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
| `ce877d21` | `feat(ui): LET-503 strip posture chips + jargon, mock-API screenshot evidence` |
| **current head** | `feat(ui): LET-503 role-gated operator chrome + populated reviewer fixtures + builder validation polish` |

PR: https://github.com/lmanualm/paperclip/pull/95

## What is in this package

| Artifact | Path | Purpose |
| --- | --- | --- |
| Route map | [`route-map.md`](./route-map.md) | Every `/eaos/*` route → component → typed API client → which counts/rows it backs. |
| No-fake-data audit | [`no-fake-data-audit.md`](./no-fake-data-audit.md) | Per-route audit of every visible count, row, badge, and tile, classifying each as real / derived / truthful-gap. **No FAIL rows.** |
| Role-gating audit | [`role-gating-audit.md`](./role-gating-audit.md) | Per-route confirmation that no operator-/admin-/destructive control is exposed to an ordinary user. **No FAIL rows.** |
| Screenshot runner | [`../../scripts/evidence/eaos-screenshots.ts`](../../scripts/evidence/eaos-screenshots.ts) | Playwright runner that drives every EAOS route through 1440×900, 1920×1080, and 1440×720 (scroll) viewports, with `--mode populated\|empty` and `--viewer operator-admin\|customer-member`. |
| Screenshot fixtures | [`../../scripts/evidence/eaos-screenshot-fixtures.ts`](../../scripts/evidence/eaos-screenshot-fixtures.ts) | Backend-shaped canned API responses used ONLY by `--mock-api` mode. Populated mode adds six agents, ten issues, three projects, an org graph, and a runs activity feed — all clearly synthetic. |
| Populated operator captures | [`screenshots/populated-operator/`](./screenshots/populated-operator/) | 42 PNGs + manifest. Populated data + operator viewer. Proves agents list rows, missions board+list, org graph nodes/edges, runs activity, approvals, and other high-signal surfaces under the LET-502 contract. |
| Populated customer captures | [`screenshots/populated-customer/`](./screenshots/populated-customer/) | 42 PNGs + manifest. Same populated data, but the viewer is a non-admin member — proves the Kernel hatch, audit pin, and `Operator session` label are gated off the customer path. |
| Empty operator captures | [`screenshots/empty-operator/`](./screenshots/empty-operator/) | 42 PNGs + manifest. Empty data + operator viewer. Proves truthful empty-state rendering for brand-new install or no-data scopes. |
| Visual QA note | [`visual-qa-note.md`](./visual-qa-note.md) | Self-scored design review against the LET-502 contract + Paperclip/Linear reference, with explicit populated-surface scores. |

## Capture instructions (screenshots)

The Playwright runner is committed so the screenshot set is reproducible on any environment that has the dev UI running. The runner uses **only commands that ship with this repo** — no global `tsx` install is required.

Two terminals:

```bash
# Terminal 1 — start the EAOS dev UI (proxies /api to your local API server).
pnpm --filter @paperclipai/ui dev

# Terminal 2 — capture in the three reviewer modes that are committed.
# (a) populated + operator-admin viewer — proves populated surfaces
./cli/node_modules/.bin/tsx scripts/evidence/eaos-screenshots.ts \
  --base http://localhost:5173 \
  --theme light \
  --mock-api \
  --mode populated --viewer operator-admin \
  --out evidence/LET-503/screenshots/populated-operator

# (b) populated + customer-member viewer — proves role gating
./cli/node_modules/.bin/tsx scripts/evidence/eaos-screenshots.ts \
  --base http://localhost:5173 \
  --theme light \
  --mock-api \
  --mode populated --viewer customer-member \
  --out evidence/LET-503/screenshots/populated-customer

# (c) empty + operator-admin viewer — proves clean empty states
./cli/node_modules/.bin/tsx scripts/evidence/eaos-screenshots.ts \
  --base http://localhost:5173 \
  --theme light \
  --mock-api \
  --mode empty --viewer operator-admin \
  --out evidence/LET-503/screenshots/empty-operator
```

### About `--mock-api`, `--mode`, `--viewer`

`--mock-api` (default ON) installs a Playwright `context.route()` interceptor that handles every `/api/*` request with backend-shaped fixtures in `scripts/evidence/eaos-screenshot-fixtures.ts`. The fixtures:

1. Force `/api/health` to return `deploymentMode = local_trusted` so `CloudAccessGate` does not redirect to the sign-in wall, and the actual EAOS React tree mounts.
2. Surface a single generic demo company (`Acme AI Labs`, `ACME` prefix) so `CompanyContext` can resolve. The id and name are clearly synthetic.
3. With `--mode populated`, return a small backend-shaped sample for the lists EAOS reads (6 agents, 10 issues, 3 projects, an org graph, a runs activity feed, 2 approvals). With `--mode empty` (or no `--mode`), every list returns `[]` so the rendered surfaces show authentic empty-state UI — no fake agents, no fake missions, no decorative metrics.
4. With `--viewer operator-admin`, set the board-access response to instance admin + company owner so the Kernel escape hatch + posture-strip audit footer chrome render. With `--viewer customer-member`, set the viewer to a non-admin member so that chrome is gated off, matching what an ordinary customer sees.

**The fixtures are not shipped to customers.** They are imported only by the screenshot runner; the product UI itself never loads them. The manifests' top-level `mockApi`, `fixtureMode`, and `viewerRole` fields let reviewers confirm exactly which mode each PNG belongs to.

### Capturing against a real backend (no mocks)

If you want to validate against a real authenticated session instead of mocks, disable the interceptor and supply a session cookie copied from your own browser tab. Do not commit the cookie:

```bash
./cli/node_modules/.bin/tsx scripts/evidence/eaos-screenshots.ts \
  --base http://localhost:5173 \
  --theme light \
  --no-mock-api \
  --cookie '__Secure-paperclip-default.session_token=...' \
  --out evidence/LET-503/screenshots/live
```

### Notable flags

- `--theme light|dark` (default `light`) writes `paperclip.theme` into `localStorage` via `addInitScript` before the React app mounts, so the captured surfaces match the LET-502 light-first design contract.
- `--mode populated|empty` (default `empty`) toggles the fixture payloads.
- `--viewer operator-admin|customer-member` (default `operator-admin`) toggles the role-gating evidence.
- `--anchor-timeout <ms>` (default `8000`) controls how long the runner waits for each route's primary `data-testid` anchor before recording the screenshot as `truthful-gap`.
- The runner **always completes successfully**: if a route's anchor or stepper button is not visible, it captures whatever is on screen, records the state as `truthful-gap` in `manifest.json`, and moves on. It never times out the entire run on a single missing selector.

Output:

- `<out>/1440/<route>.png` — desktop 1440×900.
- `<out>/1920/<route>.png` — wide 1920×1080.
- `<out>/scroll/<route>.png` — 1440×720 scrolled to bottom (scroll-proof shot).
- `<out>/manifest.json` — per-route capture status (`anchor-hit`, `truthful-gap`, `error`) including the substep / note / mock flag / mode / viewer for each PNG.

## Captured states (what the committed PNGs actually show)

| Bucket | Captures | What it proves |
| --- | --- | --- |
| `populated-operator/` | 42 anchor-hit, 0 truthful-gap, 0 error | Populated agents/issues/projects/runs/org renders correctly under the LET-502 contract. Operator viewer sees the Kernel escape hatch and audit/session footer. |
| `populated-customer/` | 42 anchor-hit, 0 truthful-gap, 0 error | Same data, customer viewer (non-admin member). Kernel hatch, `Audit · n/a`, and `Operator session` chrome are gated off. |
| `empty-operator/` | 42 anchor-hit, 0 truthful-gap, 0 error | Empty-data state. Every list surface renders its truthful "no data yet" placeholder; no fake counts, no fake activity. |

## Hard gates respected

- No deploy, no service restart, no production DB migration apply, no protected-branch merge.
- No spend, no live vendor enablement.
- No raw secrets in any file under `evidence/LET-503/`. The fixtures contain only synthetic identifiers; the Playwright runner does not write headers/cookies into PNG metadata; user-visible strings are still redacted by `secret-redact.ts` at the React layer before render.
