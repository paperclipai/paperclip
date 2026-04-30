---
name: email-followup
description: >
  Meeting Follower's primary skill — read a meeting summary from vault/meetings/,
  identify attendees + emails from vault/people/, draft personalized follow-up
  emails via Sonnet 4.6, send via Resend from meeting-bot@kspl.tech, create
  reply-tracking tickets in Paperclip. Use when a Paperclip ticket lands assigned
  to @meeting-follower with a meeting_vault_path metadata field.
---

# Email Followup

Turn a meeting summary into personalized follow-up emails + reply-tracking tickets.

## Scope

- One meeting per skill invocation
- N emails (one per non-bot attendee with email on file)
- N reply-tracking tickets

## Inputs

- A Paperclip ticket assigned to @meeting-follower with `metadata.meeting_vault_path: vault/meetings/<date>-<slug>.md`
- The meeting summary file (frontmatter + body)
- `vault/people/<slug>.md` per-person registry (frontmatter: `name`, `email`, `role`, `team`)
- Resend API key: `RESEND_API_KEY` from `.env.koenig` (shared with g4-routing skill)
- Sender mailbox: `meeting-bot@kspl.tech` (configured in Resend; SPF/DKIM verified once at setup)
- Anthropic API key for drafting personalized bodies

## Workflow

### 1. Read meeting summary + frontmatter

```python
fm = parse_frontmatter("vault/meetings/<date>-<slug>.md")
if fm.get("confidential"):
    write_skip_log("confidential")
    return BLOCK("confidential meeting; not processed")
if fm.get("no_followup"):
    write_skip_log("no_followup-flag")
    return PASS("explicitly suppressed")
attendees = fm.get("attendees", [])
action_items = fm.get("action_items", [])
decisions = fm.get("decisions", [])
```

### 2. Lookup attendees in `vault/people/`

For each attendee name, find a matching `vault/people/<slug>.md` (slug-match by lowercase + dash-space). Frontmatter must include `email` and optionally `linkedin`, `role`, `team`.

```python
recipients = []
missing = []
for name in attendees:
    person = find_person(name)
    if person and person.get("email"):
        recipients.append(person)
    else:
        missing.append(name)
if missing:
    append_to("vault/people/_missing.md", missing, today)
```

### 3. Group action items by assignee

Each action_item in the meeting frontmatter has a `proposed_assignee`. If the assignee is a chief slug, route to all team members of that chief (looked up via `companies/learnova-academy/COMPANY.md`). If it's a person name, route to that person directly.

### 4. Draft per-recipient email via Sonnet 4.6

For each recipient, compose a personalized message with their specific action items + decisions affecting them.

System prompt:

```
You are drafting a brief, professional meeting follow-up email on behalf of Vardaan Koenig (founder, Koenig AI Academy).

Recipient: {recipient.name} ({recipient.role})
Meeting: {meeting.title} — {meeting.date}
Duration: {meeting.duration_min} min
Vault link: https://academy.kspl.tech/meetings/{meeting.slug}  # placeholder until V3-7

Their action items: {recipient_action_items}
Decisions affecting them: {decisions_for_recipient}
Key quotes from them in the meeting: {their_quotes}

Draft a SHORT email (≤180 words). Voice: direct, specific, confident. NO "Hope you're well!" or other warm-up. Get to the action items in the first sentence.

Output strict JSON:
{"subject": "...",
 "body_markdown": "...",
 "expected_reply": true | false}
```

### 5. Send via Resend

```python
async with httpx.AsyncClient() as client:
    resp = await client.post(
        "https://api.resend.com/emails",
        headers={"Authorization": f"Bearer {RESEND_API_KEY}"},
        json={
            "from": "Koenig Meeting Bot <meeting-bot@kspl.tech>",
            "to": [recipient.email],
            "subject": draft.subject,
            "text": draft.body_markdown,
            "headers": {
                "X-Meeting-Vault-Path": meeting_vault_path,
                "X-Meeting-Date": meeting.date,
            },
        },
    )
    resp.raise_for_status()
```

Retry 2x with exponential backoff (1s, 4s) on 5xx. On final failure: write to `vault/marketing/email-followup-log/<date>-<meeting>-failed.md` + BLOCK ticket.

### 6. Create reply-tracking tickets

For each recipient with `expected_reply: true`:

```python
POST /api/companies/<id>/issues
{
  "title": f"Awaiting reply from {recipient.name} re: {meeting.title}",
  "description": "<full email body for context>",
  "assigneeAgentSlug": "meeting-follower",
  "metadata": {
    "expected_reply": true,
    "expires_at": "<+7 days>",
    "meeting_vault_path": meeting.path,
    "recipient_email": recipient.email,
    "action_items": recipient_action_items
  }
}
```

### 7. Audit log + parent comment

Append to `vault/marketing/email-followup-log/<YYYY-MM-DD>-<meeting-slug>.md` (metadata only, no email body):

```yaml
---
date: 2026-05-01
meeting_vault_path: vault/meetings/2026-05-01-content-sync.md
sent: 4
skipped: 1
total_cost_usd: 0.08
---

| Recipient | Email | Subject | Sent at | Resend ID |
|---|---|---|---|---|
| Vardaan Koenig | vardaan@kspl.tech | "Action items from today's content sync (3)" | 14:32 | re_abc123 |
| ... | ... | ... | ... | ... |
```

Comment on the parent meeting ticket per the AGENTS.md reporting format.

## Output

- 1 email sent per recipient (via Resend)
- 1 reply-tracking ticket per recipient with `expected_reply: true`
- 1 audit log entry in vault/marketing/email-followup-log/
- 1 comment on the parent meeting ticket

## Notes

- Per-meeting cap **$0.30**. Most meetings land $0.05-$0.15.
- Resend free tier: 3,000 emails/month; we'll burn at ~5/meeting × 30/month = 150/month, well under the limit.
- Sender domain `kspl.tech` must have SPF + DKIM + DMARC records pointing at Resend (one-time setup; verify in Resend dashboard).
- Subject line ≤60 chars (Gmail truncates at ~70). Body ≤180 words.

## Privacy

- Email body is rendered ONLY at send-time and immediately discarded; only metadata persists in the audit log.
- Confidential meetings are short-circuited at step 1; the audit log records "skipped: confidential" and nothing else.
- Bounce / spam-complaint webhooks (when wired) update `vault/people/<slug>.md` with `email_status: bounced` and prevent retries.

## Escalation

- Resend hard failure (auth error, domain not verified) → ping CEO + chief-marketing-seo
- 3+ recipients in a row missing emails → ping vault-historian to do a roster audit
- Spam-complaint received → immediate ping to CEO + Vardaan

## Budget

Per-task cap **$0.30**. Watchdog enforces.
