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

Used by `ceo`. Triggered when work passes G3 (`awaiting-g4`).

## Procedure

1. **Build a one-screen approval brief** — title, what's changing, where to preview, link to vault file or PR, list of gates already passed (G0/G_code/G2/G3 with timestamps), budget consumed, time-to-approve estimate (≤30 sec for blogs, ≤2 min for courses)

2. **Route to all 3 channels in parallel** (V1: email + Paperclip; V2: + Slack/Teams):

   **Email** (via Resend; magic-link approve):
   ```
   Subject: G4 · Approve "Anthropic 7-connector blog"? (1 of 1 in queue)

   Body:
   • What: Blog post (200 words) about Anthropic shipping 7 connectors
   • Preview: <signed-link to localhost:3010 or staging Academy>
   • Vault: vault/blogs/2026-04-29-anthropic-connectors/draft.md
   • Gates: G0 ✓ 14:30 · G_code N/A · G2 ✓ 14:50 · G3 ✓ 15:05
   • Budget: $0.42 spent ($1.00 estimated)
   • Time to review: ~30 sec

   [✅ Approve & Publish]   [❌ Reject with comment]   [📝 Open in Paperclip UI]
   ```

   **Paperclip UI queue** — task surfaces in `/g4-queue` with the same content; one-click approve buttons

   **Slack/Teams** (Phase 3) — DM with the same brief + buttons

3. **Wait for approval** — first channel to respond wins. Other channels auto-cancel after first response.

4. **On APPROVE**:
   - Trigger publish action (course → Convex agentApi `submit-for-approval` then publish; blog → same; code → merge PR)
   - Flip ticket status to `published`
   - Append to today's EOD digest

5. **On REJECT**:
   - Capture Vardaan's reject comment (required field)
   - Route back to the appropriate chief based on the reject reason
   - Flip status to `awaiting-revision`

## Inputs

- A G3-passed ticket
- Vardaan's email (`vardaan97@gmail.com`) + Slack/Teams handle (Phase 3)
- Resend API key
- Signed preview link (Vercel preview deploy or local dev URL)

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
