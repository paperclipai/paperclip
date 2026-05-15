# CRE-453 Audit: Christie Telegram Exception Alerts

**Date:** 2026-05-14
**Auditor:** Hayes (Engineering)
**Issue:** CRE-453
**Status:** Complete

---

## Q1: Does Christie have code/routines/prompts/jobs/triggers for non-scheduled Telegram alerts?

**YES — code exists on `master`, but NO automation layer.**

### Source code (on `master`)

| File | Role |
|------|------|
| `scripts/telegram-exec-alert/monitor-and-alert.sh` | Bash entry point — validates env vars, delegates to `index.ts` via `tsx` |
| `scripts/telegram-exec-alert/index.ts` | Full alert engine — polls Paperclip API for blocked tasks, pending approvals, questions for Jeff, critical issues; formats Markdown; sends via Telegram; 30-min cooldown; writes audit log |
| `scripts/send-briefing-telegram.sh` | Daily executive briefing delivery via Telegram |
| `scripts/send-briefing.sh` | Briefing generation support |
| `supabase/functions/chase-telegram/index.ts` | Supabase Edge Function with `/notify` endpoint (push-based alert API) |
| `supabase/functions/chase-telegram/lib/telegram.ts` | Core `sendTelegram` helper |

### Routines (in Paperclip, assigned to Christie)

| Routine | Assignee | Cron | Status |
|---------|----------|------|--------|
| Daily Executive Briefing | Christie | `null` | Active |
| Release Monitor Alert (GitHub → Telegram) | Christie | `null` | Active |

Neither routine has a `cronExpression` set — they rely on Christie running them during heartbeat.

### What does NOT exist

- ❌ No cron jobs or systemd timers on the server
- ❌ No Supabase scheduled functions or database triggers
- ❌ No Paperclip server-side event hooks (zero references to any alert pipeline in `server/src/`)
- ❌ No PM2 processes for alert scripts
- ❌ No webhook-based triggers from Paperclip issue changes

---

## Q2: Are Christie alert changes sitting on unmerged branches?

**No.** The alert scripts were added directly to `master`:

| Commit | Date | What was added |
|--------|------|----------------|
| `f377a667` (Merge v2026.512.0) | May 12 | `scripts/telegram-exec-alert/` + `supabase/functions/chase-telegram/` |
| `04744ac3` | May 13 | `scripts/send-briefing-telegram.sh`, `scripts/send-briefing.sh` |

There are **no unmerged branches** containing additional or different alert-related changes. The feature branch `merge/chase-telegram-fixes` was forked before these commits landed on master but a 3-way merge would preserve them.

---

## Q3: Does deployed production support only scheduled briefings?

**No — the non-scheduled alert code is on master and works when run manually.**

The scripts were verified working as recently as May 13 (Christie's daily note: "Ran monitor_and_alert — 27 blocked tasks being sent to Jeff"). However:

- **No automation layer** exists to run these scripts outside Christie's heartbeat
- Christie runs them manually during heartbeat cycles
- Between heartbeats (potentially hours), no alerts fire
- The `/notify` endpoint on the Supabase Edge Function is a viable push channel but is not called by any server-side code

**Conclusion:** Capability exists but is poll-only, manual, and opportunistic. If Christie's heartbeat doesn't run for hours, no alerts fire for hours.

---

## Q4: Can issue comments/status changes trigger Christie?

**No.** The Paperclip server (`server/src/`) contains zero references to:
- `chase-telegram`
- `monitor-and-alert`
- `send-briefing`
- `/notify` (the alert API endpoint)
- Any Telegram bot token or chat ID

There is **no event bridge** between Paperclip issue state changes and the Telegram alert system. The architecture is purely poll-based (Christie runs `monitor-and-alert.sh`), never push-based.

---

## Q5: Is Telegram send capability available outside scheduled reports?

**Yes — two independent paths exist:**

| Path | Type | Auth | When used |
|------|------|------|-----------|
| `scripts/telegram-exec-alert/monitor-and-alert.sh` | Manual script | TELEGRAM_BOT_TOKEN + JEFF_TELEGRAM_CHAT_ID + Paperclip API key | Christie's heartbeat |
| `POST /notify` on Supabase Edge Function | API endpoint | `CHASE_PAPERCLIP_API_KEY` bearer token | Not currently called by anything |

Both paths use the same `sendTelegram()` helper at `supabase/functions/chase-telegram/lib/telegram.ts` which calls `https://api.telegram.org/bot${TOKEN}/sendMessage`.

The Telegrams credentials are confirmed configured:
- `TELEGRAM_BOT_TOKEN` and `JEFF_TELEGRAM_CHAT_ID` are in the environment
- Hunter's May 12 memory confirms: "chase-telegram `/notify` endpoint exists and works"

---

## Q6: What exact source files, routines, jobs, or records control Christie's Telegram behavior?

### Files

| File | Path | Role |
|------|------|------|
| Alert entry point | `scripts/telegram-exec-alert/monitor-and-alert.sh` | Shell wrapper, checks TELEGRAM_ALERTS_ENABLED, validates env, runs index.ts |
| Alert engine | `scripts/telegram-exec-alert/index.ts` | Polls Paperclip API for blocked/approvals/questions/critical; 30-min cooldown; audit log |
| Briefing sender | `scripts/send-briefing-telegram.sh` | Sends pre-composed daily briefing to Jeff via Telegram |
| Supabase function | `supabase/functions/chase-telegram/index.ts` | Edge Function: Telegram webhook handler + `/notify` push endpoint |
| Telegram client | `supabase/functions/chase-telegram/lib/telegram.ts` | `sendTelegram()` — fetch to Telegram Bot API |
| Script duplicate | `scripts/chase-telegram/` | Local copy of the Supabase function (for testing/running locally) |
| E2E tests | `tests/e2e/telegram-alert-pipeline.spec.ts` | Tests the full alert pipeline (staging issues → running monitor script → verifying audit log) |
| E2E tests | `tests/e2e/alert-pipeline.spec.ts` | Tests the general alert/liveness pipeline |

### Routines

| ID | Name | Assigned | Cron | Last Run |
|----|------|----------|------|----------|
| `9ff0c3ca` | Daily Executive Briefing | Christie (95210561) | `null` | Unknown |
| `417c859f` | Release Monitor Alert | Christie (95210561) | `null` | Unknown |

Both routines have `status: active` but no cron expression, meaning they're not on any schedule.

### Configuration

- `TELEGRAM_BOT_TOKEN` — env var (confirmed present)
- `JEFF_TELEGRAM_CHAT_ID` — env var (confirmed present)
- `CHASE_PAPERCLIP_API_KEY` — env var for the `/notify` endpoint
- `ALLOWED_TELEGRAM_USER_IDS` — restricts which Telegram users can interact with Chase

---

## Q7: Is this a missing feature, deployment gap, disabled trigger, instruction problem, or event-routing problem?

**Primary classification: Instruction/automation gap — with a secondary deployment concern.**

### Root Cause

The feature is fully implemented, merged to `master`, and functional when manually invoked. The gap is that **no one wired it into any automation layer**. Specifically:

1. **Christie is instructed** in her AGENTS.md to run `monitor-and-alert.sh` during her heartbeat — but heartbeats are opportunistic, not guaranteed at any frequency.
2. **No cron/systemd/Supabase schedule** exists to run the script periodically.
3. **No event-driven trigger** calls the `/notify` endpoint when issues transition to blocked/critical states.
4. **No server-side hook** in Paperclip's `server/src/` integrates with the Telegram pipeline.

### Not a "missing feature"

The code exists, the credentials exist, the tests exist. This is not the same pattern as the Chase fixes (which were on a branch, never merged).

### Not a "deployment gap"

The scripts are on `master` which is the deployed branch. The Supabase Edge Function for chase-telegram was deployed (per Hunter's May 12 memory).

### Not a "disabled trigger"

No trigger exists to be disabled. The system was built as a manual tool from the start.

### Classification

**Instruction/automation gap:** The system was designed as a manual tool for Christie to invoke during heartbeat, not as an automated alert pipeline. The effective result: alerts only fire when Christie happens to run the script.

---

## Test Case: Why did Christie not alert Jeff about CRE-452 / Chase fixes?

### Scenario

- Chase Telegram fixes were trapped on `feat/opencode-deepseek-v4-switch` branch
- CRE-452 ("Merge and deploy Chase Telegram fixes...") was created and is **blocked** (on CRE-454)
- CRE-451 ("Audit why Chase Telegram fixes are not live") was also created
- Christie did **not** send Jeff a Telegram alert about this

### Why it was missed

1. **Timing:** Christie's alert script (`monitor-and-alert.sh`) polls for blocked issues. CRE-452 and CRE-451 became blocked at some point. Whether Christie ran `monitor-and-alert` between then and the expected alert time is probabilistic.
2. **Heartbeat gap:** If Christie's heartbeat didn't run `monitor-and-alert.sh` between the time these issues became blocked and the time Hunter posted his findings, no alert would have fired.
3. **No push trigger:** There is no mechanism that says "issue X just became blocked → immediately send Telegram alert."
4. **No event subscription:** Christie has no event-driven trigger for issue status changes. She only discovers blocked issues when she polls for them.

### How `monitor-and-alert.sh` would have caught it (if run)

The script queries `GET /api/companies/{id}/issues?status=blocked` which would return CRE-452 and CRE-451. It formats alerts with the category `🔴 BLOCKED TASK` and sends them to Jeff. If Christie ran the script after these issues became blocked, Jeff would have received the alert.

**The failure is that the script was not run (or not run at the right time), not that the script doesn't work.**

---

## Recommendation: Smallest Safe Fix

**Option A (infrastructure-only, no code changes):** Add a systemd timer or cron job to run `monitor-and-alert.sh` every 15 minutes. The script already has a 30-minute cooldown per item (via `COOLDOWN_MS` in the state file), so this would add resilience without spamming Jeff.

**Option B (medium effort):** Wire the Paperclip server to call `POST /notify` on the chase-telegram Supabase function when issues transition to blocked/critical states. This adds push-based alerts for immediate notification.

**Option C (both):** Implement A for resilient polling + B for immediate push on state transitions.

### All recommended fixes keep existing logging improvements

The diagnostic logging added to `scripts/chase-telegram/` catch blocks is a separate code quality improvement and is **preserved** regardless of which option is chosen.

---

## Verification

- `scripts/telegram-exec-alert/monitor-and-alert.sh` — exists on `master`, proven working (Christie's May 13 run)
- `scripts/telegram-exec-alert/index.ts` — tested via `tests/e2e/telegram-alert-pipeline.spec.ts`
- `supabase/functions/chase-telegram/index.ts` — `/notify` endpoint tested and confirmed working (Hunter's May 12 memory)
- Environment variables: `TELEGRAM_BOT_TOKEN`, `JEFF_TELEGRAM_CHAT_ID` — confirmed present
- No unmerged branches contain missing alert features
