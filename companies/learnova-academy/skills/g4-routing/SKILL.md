---
schema: agentcompanies/v1
kind: skill
slug: g4-routing
name: G4 — Human Approval Routing
description: CEO routes G3-passed work to Vardaan via three channels (email magic-link + Slack/Teams button + Paperclip UI queue). Tracks approval state; publishes on approve.
version: 0.1.0
license: MIT
sources: []
---

# G4 — Human Approval Routing

Used by `ceo`. Triggered when work passes G3 with `high_stakes: true`. **NOT the default flow** — V2.6 auto-publish skips G4 for routine content (Reviewer PASS → CEO G3 → metadata.publish_state=ready → live in <5 min). G4 fires only on:
- New course launches (multi-chapter; brand reputation stakes)
- Posts making explicit claims about competitors / vendors that could backfire
- Strategic posts where Vardaan flags `high_stakes: true` at ticket creation

## Procedure

1. **Build a one-screen approval brief** — title, what's changing, where to preview (mobile-safe URL), link to vault file or PR, list of gates already passed (G0/G_code/G2/G3 with timestamps), budget consumed, time-to-approve estimate (≤30 sec for blogs, ≤2 min for courses), reason this is `high_stakes`.

2. **Build a mobile-safe preview URL (V3-6 LOCKED)**:
   - Trigger Vercel preview deploy: `vercel deploy --prebuilt --token $VERCEL_TOKEN` (NOT `--prod`)
   - Capture the deploy URL (format `https://academy-pr-<n>-koenig-ai-academy.vercel.app/blog/<slug>`)
   - This URL works on mobile + auto-expires after 7 days
   - **Never use `localhost:3010` or `localhost:3100` — breaks on mobile**

3. **Route to channels in parallel** (V3: email + Paperclip; V3.1: + Slack/Discord):

   **Email** (via Resend):
   ```
   Subject: G4 · Approve "<title>"? (high_stakes; 1 of <queue size> in queue)

   Body:
   • What: <Blog post|Course|Course chapter> (<word count> words) — <one-line summary>
   • Why high_stakes: <reason flagged at ticket creation>
   • Preview (mobile-safe): https://academy-pr-<n>-koenig-ai-academy.vercel.app/blog/<slug>
   • Vault: vault/<path>/draft.md
   • Gates passed: G0 ✓ <HH:MM> · G_code N/A · G2 ✓ <HH:MM> · G3 ✓ <HH:MM>
   • Budget: $<spent> spent ($<estimated> estimated)
   • Time to review: ~30 sec

   [✅ Approve & Publish]   [❌ Reject with comment]   [📝 Open in Paperclip]
   ```

   **Paperclip UI queue** — task surfaces in `/g4-queue` with the same content; one-click approve buttons (https://paperclip.kspl.tech/g4-queue when V3-9 Cloudflare Tunnel lands; ngrok in interim)

   **Slack/Discord** (V3.1) — webhook with same brief + buttons

3. **Wait for approval** — first channel to respond wins. Other channels auto-cancel after first response.

4. **On APPROVE**:
   - Trigger publish action (course → Convex agentApi `submit-for-approval` then publish; blog → same; code → merge PR)
   - PATCH `metadata.publish_state="g4-approved"` (status stays `done`; publish-action cron detects this and deploys). (**Do NOT set status to "published" — invalid enum; returns 400.**)
   - Append to today's EOD digest

5. **On REJECT**:
   - Capture Vardaan's reject comment (required field)
   - Route back to the appropriate chief based on the reject reason
   - Set status to `in_progress` + `metadata.publish_state="rejected"` (**"awaiting-revision" is not a valid enum value**)

## Inputs

- A G3-passed ticket WITH `high_stakes: true` in description metadata (auto-publish flow handles all others)
- Vardaan's email (`vardaan97@gmail.com`) + Slack/Discord webhook (V3.1)
- Resend API key
- Vercel preview deploy URL (mobile-safe; auto-expires 7 days)

## Outputs

- 1 email sent
- 1 Paperclip queue entry
- (Phase 3) 1 Slack/Teams message
- Approval state captured + downstream action triggered

## Never do

- Never auto-approve. Ever. G4 is the human gate — that is the whole point.
- Never lose the reject comment — it's the corrective signal
- Never publish before all 3 channels are dispatched (ensures redundancy)
- Never publish after a reject (even a stale approve from a different channel)
- Never include sensitive secrets/PII in the email

## Escalation

- No response in 24h → resend reminder + ping
- Same ticket rejected twice → flag for next weekly retro; possibly the brief is wrong

## Budget

Per-task cap $0.25.
