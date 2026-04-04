---
name: check-communications
description: Check all communication channels for pending responses and new messages
---

# Check Communications

Use this skill to check all communication channels for responses to pending outgoing messages.

## Procedure

### Step 1 — Load tracker

Read `communications-tracker.json` from your project workspace. If the file doesn't exist, report that there are no tracked communications and stop.

### Step 2 — List pending items

Display all entries with `status: "pending"`, grouped by channel:

```
**Pending Communications:**

Gmail:
  - [2026-03-24] biuro@example.com — Quote request (project-name)

Telegram:
  (none pending)
```

If no pending items exist, report "All communications resolved" and skip to Step 5.

### Step 3 — Check channels

For each channel that has pending items OR a stale `last_checked` date:

**Gmail (prefer API):**
1. Use the `gmail-api` skill to check for replies:
   ```bash
   python <gmail-api-skill-path>/scripts/gmail_read.py search "from:<recipient> after:<sent_date>" --max 5
   ```
2. If results are found, read the most recent message to confirm it's a reply:
   ```bash
   python <gmail-api-skill-path>/scripts/gmail_read.py get <message_id>
   ```
3. Report findings for each item: response found (with summary) or still waiting

**Gmail (browser fallback):** Only use if the `gmail-api` skill is not available or credentials are missing:
1. Navigate to Gmail (mail.google.com)
2. Authenticate if needed (use the `authenticate` skill)
3. For each pending Gmail item: search for replies from the recipient
4. Report findings for each item: response found (with summary) or still waiting

**Telegram:**
1. Navigate to Telegram Web (web.telegram.org)
2. Authenticate if needed (use the `authenticate` skill)
3. For each pending Telegram item: navigate to the relevant conversation and check for new messages since `sent_date`
4. Report findings

**Other channels (phone, mail, in-person):**
- Ask the user if they have received any response via this channel

### Step 4 — Update tracker

For each pending item, ask the user what action to take:
- **Mark resolved** — set status to `resolved`, record `resolved_date` and `resolution`
- **Follow up** — draft a follow-up message (do NOT send). Set a `follow_up_date` for reminder
- **Mark expired** — set status to `expired` if no longer relevant
- **Keep waiting** — optionally set a `follow_up_date` for future reminder

For every decision, update the `notes` field with a dated summary of the analysis.

Update `channel_checks.<channel>.last_checked` to today for each channel checked.

Save all changes to `communications-tracker.json`.

### Step 5 — Summary

Present a final summary:
- How many items were resolved this session
- How many are still pending
- Next recommended check date
