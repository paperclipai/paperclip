# Smoke Lab — agent-driven browser runner (runbook)

**Ticket:** PAP-13350 (plan §D4 item 1). **Companion script:** [`tests/e2e/smoke-lab-browser-runner.mts`](../../tests/e2e/smoke-lab-browser-runner.mts).
**Scenario source of truth:** [`tests/e2e/smoke-lab.catalog.ts`](../../tests/e2e/smoke-lab.catalog.ts) — **do not fork the step list.**

This is the manual/agent counterpart to the deterministic Playwright CI mirror
(`tests/e2e/smoke-lab.spec.ts`, S4). Where the CI mirror runs headless in a
throwaway instance for a red/green gate, this runbook has a **QA agent drive a
real browser** through the same P1–P7 lifecycle against a live instance,
**typing demo credentials into the fake OAuth provider's real consent page**, and
records every step + a viewable screenshot to the Smoke Lab results API so the run
shows up in the **Smoke Lab tab** and the **dashboard "Integration smoke" card**.

---

## 0. The one hard prerequisite: a `local_trusted`, non-production instance

The Smoke Lab feature **fail-closes** on public exposure only
(`server/src/services/smoke-lab.ts` → `assertEnabled()`):

| Requirement | Why |
|---|---|
| `experimental.enableSmokeLab = true` | feature flag (board experimental settings) |
| deployment exposure ≠ `public` | never expose the fake OAuth provider / loopback MCP sidecars to the open internet |

The auth mode (`local_trusted` vs `authenticated`) and `NODE_ENV` do **not** gate
the Smoke Lab — a private box is a private box. Every smoke-lab service method calls
`assertEnabled()`, so on a `public` instance you get
`403 {"error":"Smoke lab is only available on private (non-public) deployments"}`
(or `404 Smoke lab is disabled` when the flag is off).

**The shared dev worktree service works as-is now.** The Paperclip-managed dev
service (`pnpm dev`, `PAPERCLIP_DEPLOYMENT_MODE=authenticated` + `NODE_ENV=production`,
e.g. `http://paperclip-dev:45439`) is private, so it can run the Smoke Lab directly —
just turn the flag on. (Historically it was blocked because the gate required
`local_trusted` + non-`production`; that restriction was removed in PAP-13351.) The
installed package on `:3100` still may not ship the smoke-lab routes (404).

If you prefer an isolated, no-login throwaway instance, boot one exactly the way the
e2e config does (`tests/e2e/playwright.config.ts`):

```bash
export NODE_ENV=test PORT=3211 \
  PAPERCLIP_HOME=/tmp/pap-smoke-home \
  PAPERCLIP_INSTANCE_ID=pap-smoke \
  PAPERCLIP_CONFIG=/tmp/pap-smoke-home/instances/pap-smoke/config.json \
  PAPERCLIP_BIND=loopback \
  PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private
pnpm paperclipai onboard --yes --run    # serves http://127.0.0.1:3211, own embedded PG
# wait for: GET /api/health -> 200
```

In `local_trusted` mode there is **no auth wall** — board access is implicit, so
plain `curl`/`fetch` with an `Origin: <base>` header is a board actor. On an
`authenticated` instance (Tailscale dev, `:45439`) you instead log in —
`POST /api/auth/sign-in/email` with QA creds — and carry the `*.session_token`
cookie; board **mutations** also require the `Origin` header. A control-plane **run
JWT is NOT accepted by a separate worktree instance's DB** — cross-instance tokens
403.

---

## 1. Auth model for the results API

| Endpoint group | Authz | Actor that works here |
|---|---|---|
| `services/start`, `services/stop`, `install-fixtures`, `reset`, `services` (GET) | `assertBoard` | board only (local_trusted implicit board, or session cookie) |
| `runs`, `runs/:id`, `runs/:id/steps`, `runs/:id` (PATCH) | `assertBoardOrAgent` | board **or** an agent run JWT |
| `oauth/authorize|token|userinfo|revoke` | flag+deployment gated, unauthenticated | the fake provider itself |

So the hybrid the ticket asks for: **start services / install fixtures through
the board UI**, **post step results with the run JWT** (or the board session on
this instance). Screenshots become viewable in the UI by uploading each PNG as a
company asset and putting its served URL in the step's `screenshotArtifactRef`.

---

## 2. Fixed fixture facts

- **Demo OAuth creds:** `smoke@paperclip.test` / `smoke-password` (`SMOKE_LAB_DEMO_*`). Email is pre-filled on the consent page; you type the password.
- **Fake OAuth scopes:** only `smoke:openid smoke:profile smoke:email` are accepted — any other `scope` → `400`.
- **Consent page:** `GET /api/companies/:cid/smoke-lab/oauth/authorize?client_id=…&redirect_uri=…&scope=…&state=…&response_type=code` renders the "SMOKE TEST — not a real provider" login+consent form. Submitting valid creds → `302` to `redirect_uri?code=…` (wrong creds → `403`). The redirect target is a dead loopback callback — don't wait for it to load; assert on the **302 + `code=` in the Location header**, then let the failed navigation commit before driving the Paperclip UI.
- **Two connections per install:** `remote_http` (HTTP MCP fixture, used for P1/P2/P5/P6/P7) and `local_stdio` (used for P3/P4). `install-fixtures` is idempotent.
- **Lifecycle tools** (from the catalog): HTTP → read `todo.list`, write `todo.add`, deny `email.send`, quarantine `fixture.schemaFlip`; stdio → read `time.now`, write `slow.ping`, deny `crash.now`.

---

## 3. Per-scenario lifecycle (mirror the catalog — 8 steps)

For each `ciSmokeLabScenarios` entry, drive the browser + board API through:

1. **connect** — start services + install fixtures; navigate the scenario's
   `uiEntryPath` (`apps`/`advanced`/`review`/`activity`/`attention`). For the
   **P1 OAuth** scenario, first open the consent page, **type the demo creds**,
   submit, and assert the `302`+`code`.
2. **discover-catalog** — `GET /api/tool-connections/:id/catalog`; assert it
   contains the scenario's `allowedRead` tool; screenshot the connection UI.
3. **allowed-read** — `POST /api/tool-connections/:id/test-calls` with the read
   tool; expect `decision:"allowed"`, no error; confirm an audit row; screenshot Activity.
4. **ask-first-write-approved** — create a `require_approval` policy
   (`POST /api/companies/:cid/tools/policies`), issue the write test-call
   (`decision:"ask_first"` + `actionRequestId`), open **Review**, approve
   (`POST /api/tool-gateway/action-requests/:id/approve` `{companyId}`), poll to `done`.
5. **denied-blocked-call** — create a `block` policy, issue the denied tool;
   expect `decision:"off"` + `error.reasonCode`; screenshot Review.
6. **schema-change-quarantine** — HTTP only: set `config.quarantineNewEntries`,
   allow + call `fixture.schemaFlip`, `POST …/catalog/refresh`, assert
   `quarantinedCount > 0`; screenshot **Attention**. (Non-HTTP records
   governance evidence via fixture metadata on Activity.)
7. **revoke** — gateway scenario: create a run-scoped gateway session, list tools
   (200), revoke, re-list (401). Others: `PATCH …/tool-connections/:id
   {enabled:false}` then re-enable. Screenshot the connection.
8. **audit-evidence** — re-assert the audit row; screenshot Activity.

Record each step: `POST /api/companies/:cid/smoke-lab/runs/:runId/steps` with
`{ path, scenarioStep, status, detail, screenshotArtifactRef:{kind,url}, durationMs }`.
For a viewable screenshot: `POST /api/companies/:cid/assets/images` (multipart
field `file`, PNG) → use `<base>${contentPath}` as the ref `url`.

**Run lifecycle:** `POST …/smoke-lab/runs {trigger:"manual"|"ci"|"routine", summary}`
→ record steps → `PATCH …/runs/:id {status:"passed"|"failed", summary}`. Finish by
screenshotting `/{PREFIX}/apps/advanced/smoke-lab` (matrix + run history) and
`/{PREFIX}/dashboard` (the "Integration smoke" card).

---

## 4. Run it

```bash
# with the local_trusted instance from §0 already serving on :3211
node --experimental-strip-types tests/e2e/smoke-lab-browser-runner.mts
#   SMOKE_BASE=http://127.0.0.1:3211  (default)
#   SMOKE_COMPANY_ID=<uuid>           (optional; else a fresh company is created)
#   SMOKE_SHOT_DIR=/tmp/pap13350-shots
```

The runner launches real Chromium via the ARM64 wrapper
(`.paperclip/browser-runtime/chromium-arm64/bin/chromium-agent-browser`) — see
`memory/agent-browser-arm64-chromium`; on this aarch64 host the default puppeteer
Chrome is x86-64 and won't launch. It prints the `runId` and a per-path step
count and writes `${SHOT_DIR}/result.json`.

---

## 5. Handling failures

A failing step is recorded with `status:"fail"` and its error/`-failed.png`, and
the run is finalized `failed`. Triage each failure:

- **Product/UI defect** → file a child issue **assigned to the owning coder**
  (S1/S2 for API/UI, S4 for the catalog/mirror), with repro + the failed
  screenshot, and set a blocker. Do not close S5 green over a real defect.
- **Runner/environment issue** (selector drift, wrong scope, dead-callback race —
  all hit during first authoring) → fix the runner and re-run; don't file product bugs.

Never post a PASS if the UI was not actually exercised in a real browser (see the
QA "Forbidden PASS shape" rule).
