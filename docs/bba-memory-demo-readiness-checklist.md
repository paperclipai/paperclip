# BBA Memory — Demo Readiness Checklist

**Audience**: Costel (operator running the CEO/CTO demo)  
**Demo duration**: ~10 minutes  
**Full script**: [`docs/bba-memory-demo-runbook.md`](bba-memory-demo-runbook.md)  
**Last reviewed**: 2026-05-10

> **Tone**: This feature is production-capable for single-operator use at small scale. The idempotency story is solid. The UI is prototype-grade — honest about that if asked directly.

---

## T-7 Days — Planning Checklist

- [ ] **Confirm target environment**: Is the demo running on staging or production? Never use production bookmaker account with real money. Use a test account with a pre-funded small balance.
- [ ] **Confirm PRs in demo env**: Which PRs are merged into the demo deployment? At minimum you need #5583 + #5595 + #5601 + #5602 + #5604 + #5636. Check with the deployment team.
- [ ] **Book a test bookmaker account**: Register a Casa Pariurilor test account (or use the existing one). Confirm it is not rate-limited or temporarily banned.
- [ ] **Decide on dry-run vs. live**: `BBA_DRY_RUN=true` means the browser session runs but the final submit click is skipped. Recommended for all rehearsals. For the actual CEO/CTO demo, decide jointly whether to show a real placement (impressive but irreversible) or dry-run (safe, slightly less dramatic).
- [ ] **Create demo company in Paperclip**: A dedicated "BBA Demo — [Date]" company with secrets seeded. Do not reuse existing companies.
- [ ] **Identify demo audience technical level**: CEO/CTO may want to understand the idempotency story. Prepare a one-sentence explanation.
- [ ] **Rehearse once with a junior**: Run through the full 8-minute happy path with a colleague playing the CEO role. Time it.
- [ ] **Reserve meeting room with HDMI/USB-C**: Screen share is unreliable; direct projector preferred.

---

## T-1 Day — Environment + Data Prep

### Data preparation

- [ ] **Clean the BBA Memory DB**: `rm ~/.paperclip/bba-memory/bba-memory.db` then restart the server. You want a zero-entry recent-runs list for a clean "before/after" visual.
- [ ] **Seed the demo company**:
  ```bash
  # Via Paperclip admin or API
  POST /api/companies/  body: { name: "BBA Demo" }
  POST /api/companies/:id/secrets  body: { name: "bba-demo-username", value: "<test email>" }
  POST /api/companies/:id/secrets  body: { name: "bba-demo-password", value: "<test password>" }
  ```
- [ ] **Verify secrets resolve**: `GET /api/companies/:id/secrets` — confirm both secrets exist.
- [ ] **Pre-load a bookmaker config preset**: Open the Operator Playground and verify the "Casa Pariurilor" preset populates all fields without errors.

### Dry run

- [ ] **Run the full happy path with `BBA_DRY_RUN=true`**: Place a bet end-to-end. Result should be `status: "success"` in dry-run mode.
- [ ] **Verify Recent Runs panel updates**: Confirm the new run row appears within 30 seconds.
- [ ] **Verify stats summary**: `GET /api/companies/:id/bba-memory/stats-summary` shows `totalRuns: 1, successCount: 1`.
- [ ] **Test idempotency replay**: Within 60 seconds of the dry run, click "Place Bet" again. Confirm the "A bet was submitted less than 60s ago" warning appears.
- [ ] **Delete the dry-run DB entry** after rehearsal: `rm ~/.paperclip/bba-memory/bba-memory.db` and restart, so the demo starts fresh.

### Rollback rehearsal

- [ ] **Practice the abort script** (see Failure Recovery section below): if the demo live bet fails, know exactly what you'll say.
- [ ] **Confirm Telegram bot is configured** (optional): if rate-limit or CAPTCHA fires during demo, Telegram alert should pop. Ensure your phone is on silent but screen visible.

---

## T-30 Minutes — Final Smoke Checks

Run these immediately before the audience enters.

```bash
# 1. Server is healthy
curl http://localhost:3000/health

# 2. BBA Memory DB is clean (0 runs)
curl -s http://localhost:3000/api/companies/$DEMO_COMPANY_ID/bba-memory/recent-runs \
  | python3 -m json.tool | grep '"total"'
# Expected: "total": 0

# 3. Stats summary endpoint responds
curl -s http://localhost:3000/api/companies/$DEMO_COMPANY_ID/bba-memory/stats-summary

# 4. Operator Playground loads in browser — no console errors
# Open Chrome DevTools, reload the page, confirm Console tab is clean

# 5. Chromium profile is pre-authenticated
# Open a browser with the bookmaker pre-auth profile and confirm logged-in state
# (only needed if execution.skipLogin = true)

# 6. Test bookmaker account not rate-limited
# Navigate to Casa Pariurilor manually, confirm login works, confirm no CAPTCHA
```

If any check fails:
- **Server unhealthy**: restart server, wait 30s, retry.
- **DB not clean**: `rm ~/.paperclip/bba-memory/bba-memory.db` + restart.
- **Playground console errors**: hard-reload (Ctrl+Shift+R) then check if a recent master merge broke the build.
- **CAPTCHA on bookmaker**: use a different IP, clear cookies, or switch to `BBA_DRY_RUN=true` and explain the live demo is risk-controlled.

---

## During Demo — Operator Script

Follow the timing table in [`docs/bba-memory-demo-runbook.md`](bba-memory-demo-runbook.md) (Happy Path Script section).

**Key talking points** to keep ready on a notes card:

1. "The modal requires typing the word CONFIRM — this is a deliberate friction point. A mis-click can't place a real bet."
2. "The spinner shows the browser automation is running — Playwright is opening Chrome, navigating the site, finding the bet, and clicking submit."
3. "The idempotency key means: if the network drops and the client retries, the bookmaker won't see a duplicate request."
4. "The Recent Runs panel updates automatically. In partial status, it re-checks every 5 seconds for up to a minute."
5. "Every run is archived: a Playwright trace zip and a final screenshot. If anything goes wrong, we have a full audit trail."

---

## Failure Recovery Scripts

### CAPTCHA detected

**Symptom**: Result panel shows `❌ Bet failed. Reason: CAPTCHA_VISIBLE`.  
**Script**:
> "The bookmaker triggered a CAPTCHA challenge — this is their anti-bot protection firing. The system detected it automatically and stopped rather than guessing. In production, this triggers a Telegram alert so the operator can manually re-authenticate. Let me show you what the audit trail looks like for this failure."
> 
> Point to the Recent Runs panel showing the `CAPTCHA_VISIBLE` row with `outcome: failure`.  
> **Recovery**: Switch to dry-run mode (`BBA_DRY_RUN=true`) for the rest of the demo.

### Rate limit hit

**Symptom**: Result panel shows `❌ Bet failed. Reason: RATE_LIMITED` or HTTP 429 from server.  
**Script**:
> "The rate limiter fired — we limit to 10 placement attempts per minute per company. This prevents a runaway automation loop from exhausting the bookmaker account. Let me reset the counter and we'll proceed."
>
> Wait 60 seconds, then retry.  
> **Recovery**: If still rate-limited, show the recent-runs panel and stats-summary endpoint as the "live outcome" demonstration instead of a new placement.

### Network drop / browser crash

**Symptom**: Spinner hangs for > 60s, no result panel appears.  
**Script**:
> "The session timed out — the network connection between the server and the bookmaker dropped. Notice the result panel hasn't appeared — this is the system being honest: it doesn't know if the bet was placed. The operator would check the bookmaker's bet history directly."
>
> **Recovery**: Restart the server (`pnpm --filter server dev`), confirm recent-runs shows the stale run with `outcome: null`, explain partial state handling.

### Idempotency window blocks re-demo

**Symptom**: After a successful bet, operator tries to demo again within 60 seconds and the "Place Bet" button is grayed out with the 60s warning.  
**Script**:
> "This is the idempotency guard — we block a second submission for 60 seconds to prevent duplicates. This is by design. Let's wait 60 seconds and try again."
>
> **Recovery**: Use the 60-second gap to demo the stats-summary endpoint and the metrics page.

### Playwright / Chromium won't launch

**Symptom**: Result panel shows `BROWSER_CRASH` or no response.  
**Script**:
> "The browser process didn't launch — likely a system resource issue on this machine. Let me switch to dry-run mode which uses a lighter code path."
>
> **Recovery**: Set `execution.headless: true`, retry. If still failing, show the API endpoints and BBA Memory DB directly from the terminal as a "systems view" fallback.

---

## Open Issues That Could Bite During Demo

| Issue | Risk | Workaround |
|-------|------|-----------|
| **Cross-fork PR auto-merge limitation**: #5641 and later docs PRs can't auto-merge until maintainers approve | Demo deployment may not have Phase F+ UI (auto-retry, replay banner) | Demo the idempotency cache via API (`X-Idempotent-Replay` header in curl) rather than UI replay banner |
| **`@testing-library/react` not in main yet** (#5606 not merged): UI tests skipped in CI for BBA components | CI passes with no BBA UI test coverage — a bug could exist undetected | Run a manual smoke test of all panel interactions within T-1 day dry run |
| **Idempotency cache is in-process SQLite**: restarting the server wipes the 60s cache | If server restarts mid-demo, idempotency protection is lost for in-flight keys | Don't restart the server during demo. If you must, warn audience the 60s window resets. |
| **Rate limiter is per-process** (Codex's Phase F backend PR): multi-instance deployment doesn't share rate-limit state | High-availability deployments could bypass the rate limit | Demo on a single-instance environment. Document as known gap for multi-instance. |
| **`shouldUseCdpPersistentProfile` not yet in demo env** (pending split-plan execution): CDP mode unavailable | `skipLogin: false` flows will do full login every time | Demo with a pre-authenticated profile (`skipLogin: true`) to avoid the CDP dependency |
| **BBA Operator Playground (#5604) may not be merged**: no integrated UI page | Individual C1/C2 components work but no combined view | Navigate directly to the Playground route if it's deployed, or demo C1/C2 separately |

---

## Emergency Contacts

- **Costel**: primary operator — knows the system
- **cryppadotta / devinfoley**: can push a hotfix within ~20 min if a critical bug is found T-30 min before demo
- **Telegram bot**: configured to alert on `CAPTCHA_VISIBLE` and `RATE_LIMITED` failure classes (when Phase F+ backend PR lands)

---

## Post-Demo

- [ ] Delete the demo company (or mark it inactive) to prevent billing surprises.
- [ ] Archive the BBA Memory DB (`cp ~/.paperclip/bba-memory/bba-memory.db ~/.paperclip/bba-memory/bba-memory-demo-<date>.db.bak`) before wiping.
- [ ] Capture follow-up issues from the Q&A (see runbook "Post-Demo Follow-ups" section).
- [ ] Update PR descriptions with any findings from the demo session.
