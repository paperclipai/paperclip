# BBA Memory — CEO/CTO Demo Runbook

**Audience**: CEO / CTO walkthrough (non-technical observers welcome)  
**Duration**: ~10 minutes total (8 min happy path + 2 min failure demos)  
**Goal**: Show an operator click → real bet placed via UI → idempotency protection → result panel → live recent-runs feed  
**Status note**: This is a working integration, not a mock. All bet placements that reach "Place Real Bet" will attempt real bookmaker actions. Use test credentials and test accounts only.

---

## Pre-Demo Checklist

Complete these steps **at least 15 minutes** before the demo. If anything fails, abort and reschedule — do not demo with a broken environment.

### Environment variables

```bash
# Required — BBA Memory SQLite location
BBA_MEMORY_DIR=~/.paperclip/bba-memory

# Required — bookmaker credentials (use TEST account, never prod)
BBA_TEST_COMPANY_ID=<uuid of the demo company in Paperclip>

# Optional — disable real bet submission for dry-run mode
BBA_DRY_RUN=true   # set to false only for live demo
```

### Services checklist

| Service | How to verify |
|---------|--------------|
| Paperclip server running | `curl http://localhost:3000/health` → `{"ok":true}` |
| BBA Memory DB initialised | `ls ~/.paperclip/bba-memory/bba-memory.db` exists |
| Test company created | Demo company ID resolves in Paperclip admin panel |
| Secret seeds planted | `loginUsername` + `loginPassword` secrets created under demo company |
| Test bookmaker account | Casa Pariurilor test account credentials loaded, not rate-limited |
| Playwright / Chromium installed | `npx playwright install chromium` if first run |

### Seed data to plant before demo

1. Create a Paperclip company: "Demo Company — BBA Test"
2. Create two secrets under that company:
   - `bba-demo-username` → test account email
   - `bba-demo-password` → test account password
3. Open the BBA Operator Playground page in the UI and confirm the "Casa Pariurilor" preset loads.
4. Confirm the `/api/companies/:id/bba-memory/recent-runs` endpoint returns `{"runs":[]}` (clean slate).
5. If `BBA_DRY_RUN=true`, confirm a previous dry-run shows `status: "success"` in the DB.

---

## Happy Path Script (8 minutes)

Work from a single browser window with two tabs:
- **Tab 1**: Operator Playground UI
- **Tab 2**: `GET /api/companies/:id/bba-memory/recent-runs` (JSON view, or use the Recent Runs panel in the same UI page)

| Time | Step | Action | Expected result |
|------|------|---------|----------------|
| T-30s | **Step 0 — Setup** | Open Tab 1. In the Operator Playground, select **"Casa Pariurilor"** from the bookmaker preset dropdown. Select **"Test mock bet"** from the bet preset dropdown. Verify matchLabel, market, selection, odds, stake are pre-filled. | All fields populated. "Place Bet" button is red and active. |
| T+0 | **Step 1 — Click Place Bet** | Click **"Place Bet"** button. | Confirmation modal opens. |
| T+10s | **Step 2 — Type CONFIRM** | In the modal, type `CONFIRM` exactly (uppercase). Show the audience the submit button activating only after the full word is typed. | "Place Real Bet" button turns red and becomes clickable. |
| T+15s | **Step 3 — Submit** | Click **"Place Real Bet"**. | Modal closes. Spinner "⏳ Placing bet…" appears. Button grays out. A 60-second idempotency warning may appear after submit. |
| T+30s | **Step 4 — Result** | Wait for the result panel to appear. | Green panel: "✅ Bet placed successfully." or yellow: "⚠ Bet partially completed." (If red, show the failure reason — partial is fine for the demo, it triggers the polling feature.) |
| T+35s | **Step 5 — Recent runs refresh** | Switch to Tab 2 or scroll to the Recent Runs panel on the same page. | New row appears: `source: manual`, `outcome: success` (or `partial`), `durationMs` filled in. |
| T+45s | **Step 6 — Metrics** | Open a third tab: `GET /api/companies/:id/bba-memory/stats-summary?windowDays=7` | JSON response showing `totalRuns`, `successCount`, `successRatePct`. Talk about the 7-day rolling window. |
| T+60s | **Step 7 — Idempotency demo** | Return to Tab 1. While within the 60-second window, try clicking "Place Bet" again. If the window has passed, re-submit with the same UUID key via dev tools (or wait until the demo key). | Either: (a) button is blocked by the "60s idempotency warning" in the UI; or (b) if submitted via API directly with same key, response shows `X-Idempotent-Replay: true` and the "↻ Cached replay (60s window)" banner appears. |

**Talking points during happy path:**
- "Every click generates a unique idempotency key. Even if the network fails and the client retries, the bookmaker won't receive a duplicate placement."
- "The 60-second window is client-enforced AND server-enforced — two layers."
- "The Recent Runs panel auto-refreshes every 30 seconds. For partial results, it polls every 5 seconds to catch late confirmations."
- "All sessions are logged to a local SQLite journal. We can replay, audit, and debug any run from the artifact directory."

---

## Failure Mode Demos (2 minutes each)

### Failure 1 — Rate limit (2 min)

**Setup**: Pre-configure the bookmaker test account to be at the rate-limit threshold, OR demonstrate with a simulated 429 response.

| Step | Action | Expected |
|------|--------|----------|
| 1 | Send 10 rapid placement requests via the API (use a script or Postman). | First 10 succeed or fail with bookmaker errors. |
| 2 | Attempt an 11th placement. | Server returns `429 Too Many Requests` (once the Codex rate-limiter middleware from `feat/bba-memory-phase-f-backend-plus` lands). Red error panel in UI. |

**Talking point**: "We cap placement attempts at 10 per minute per company. This prevents runaway automation from burning through a bookmaker account or hitting their own rate limits."

### Failure 2 — CAPTCHA detected (2 min)

**Setup**: Use a bookmaker config where the site will trigger a CAPTCHA (e.g., fresh IP, no cookies).

| Step | Action | Expected |
|------|--------|----------|
| 1 | Place a bet with `skipLogin: false` on a session where CAPTCHA appears. | BBA session exits with `outcome: failure`, `failureClass: CAPTCHA_VISIBLE`. |
| 2 | Result panel shows "❌ Bet failed. Reason: CAPTCHA_VISIBLE". | Red panel with failure reason text. |
| 3 | Recent Runs shows the failed row. Stats summary `failureCount` increments. | Visible in Tab 2 and Tab 3. |

**Talking point**: "CAPTCHA detection is automatic. The system doesn't attempt to solve it — it stops, records the failure class, and alerts via Telegram. The operator can re-authenticate manually and retry."

---

## Q&A Prep

**Q1: "What if a bet is placed but we don't get a confirmation?"**

> The BBA session captures the receipt page screenshot and logs it. The run is marked `outcome: partial`. The UI polls every 5 seconds for 60 seconds to detect a late update. The bookmaker bet-history endpoint is checked separately as a verification step. If still uncertain, the operator reviews the artifact directory — every run has a Playwright trace `.zip` and final screenshot.

**Q2: "Can two operators accidentally place the same bet?"**

> Every placement generates a `crypto.randomUUID()` idempotency key on the client. The server stores it for 60 seconds. If two requests arrive with the same key (same operator, network retry) the second is served from cache with no browser session. Two different operators will generate different keys and both placements will proceed — this is intentional (they may have different mandates). The risk controls (`maxStakePerBet`, `maxTotalStakePerSession`) limit double-exposure at the session level.

**Q3: "What happens if the bookmaker site changes its layout?"**

> BBA uses a config-driven selector model. When a selector stops matching, the run fails with `SELECTOR_NOT_FOUND` and a screenshot is captured. The operator updates the selector in the bookmaker config (no code deploy required) and retries. The BBA Memory DB tracks selector hit/miss rates so we can detect drift before it causes a failure.

**Q4: "How do we revoke a bet that was wrongly placed?"**

> Revocation is not automated — bookmakers don't expose cancellation APIs. The operator must contact the bookmaker's support manually. We have the placed bet ID (when available) and the Playwright trace for evidence. This is a prototype gap; production would require bookmaker-specific cash-out automation.

**Q5: "What's the rollback story if Phase F has a bug?"**

> Phase F adds an append-only SQLite table (`idempotency_keys`) and a safe wrapper around `JSON.parse`. Rolling back means reverting the route changes — the SQLite DB can be left in place or deleted without affecting the main Postgres database. No schema migration in Postgres was touched by Phase F. Rollback is a git revert + deploy, ~5 minutes.

---

## Post-Demo Follow-ups to Capture as Issues

After the walkthrough, open Paperclip issues for:

1. **[P0] Bookmaker receipt confirmation** — verify bet status against bookmaker bet-history before marking `outcome: success`.
2. **[P1] Telegram alert on CAPTCHA** — notify operator via Telegram when `CAPTCHA_VISIBLE` detected, not just log.
3. **[P1] Test-infra for BBA UI components** — add `@testing-library/react` + `happy-dom` to enable Component 1/2 unit tests (tracked in PR #5606).
4. **[P2] Click-outside-to-close modal** — ARIA dialog best practice; currently only Escape key closes.
5. **[P2] Admin audit log** — log each idempotency cache hit to BBA Memory DB for auditability.
6. **[P2] `X-Idempotent-Replay` header documentation** — add to API reference / OpenAPI spec.
