# Daily Lead Outreach Routine

**Trigger:** Every day at 22:30 IST (17:00 UTC) via Paperclip schedule routine  
**Concurrency policy:** `skip_if_active` — if previous run still awaiting approval, skip today's run  
**Catch-up policy:** `skip_missed`

---

## Configuration

All config lives in **SharePoint** at `Marketing-Specialist/config.md`.

| Key | Default | Description |
|-----|---------|-------------|
| `apollo_file` | `apollo-contacts-export.xlsx` | Filename at SharePoint drive root |
| `apollo_sheet` | `in` | Sheet name containing contacts |
| `batch_size` | `3` | Rows to process per run |
| `review_email` | `marketing@medicodio.site` | Who receives the review notification |
| `outlook_user` | `marketing@medicodio.site` | Mailbox where drafts are saved |

To change any value, update `Marketing-Specialist/config.md` in SharePoint. No code change needed.

---

## Excel Columns Used

The routine reads from the Apollo export Excel and writes back audit columns.

**Read columns (exact headers in Apollo sheet `in`):**
- `First Name`
- `Last Name`
- `Email`
- `Company Name`
- `Company Name for Emails`
- `Title`
- `Seniority`

**Written audit columns (added automatically on first run):**
- `paperclip_status` — `pending` | `draft_created` | `sent` | `skipped` | `replied` | `demo_interest`
- `paperclip_draft_id` — Outlook draft message ID (for sending on approval)
- `paperclip_processed_at` — ISO timestamp of when processed
- `paperclip_issue_id` — Paperclip issue ID this row belongs to
- `paperclip_notes` — any error or skip reason
- `paperclip_reply_at` — ISO timestamp of reply received
- `paperclip_reply_intent` — `demo_interest` | `info_request` | `not_interested` | `out_of_office` | `other`
- `paperclip_reply_summary` — one-line summary of reply content

---

## Step-by-Step Execution

### PHASE 0 — Check for replies (runs FIRST, every trigger)

Do this before processing new leads. It is independent of the approval state.

```
0a. outlook_search_emails
    → query: "from:* to:marketing@medicodio.site subject:Medicodio"
    → top: 50
    → scan for replies to outreach emails sent by this routine

0b. For each reply found:
    - Read full email: outlook_read_email messageId="{id}"
    - Extract: sender name, sender email, subject, body

0c. Classify reply intent using these rules:
    - "demo_interest"    → mentions demo, call, meeting, schedule, interested, let's connect, book
    - "info_request"     → asks questions, wants more info, pricing, features
    - "not_interested"   → unsubscribe, no thanks, not relevant, remove me
    - "out_of_office"    → auto-reply, OOO, vacation, out of office
    - "other"            → anything else

0d. For each reply classified:

    IF intent = "demo_interest":
      → outlook_send_email
         to: marketing@medicodio.site
         subject: "🔥 [DEMO INTEREST] {Sender Name} from {Company} replied!"
         body: "Karthik — {Sender Name} ({sender email}) at {Company} is interested in a demo.
                Their reply: {reply body excerpt}
                Action needed: Follow up immediately."
      → create Paperclip issue (high priority):
         title: "DEMO INTEREST — {Sender Name} at {Company} wants a meeting"
         assignee: board/CEO
         priority: high
         body: full reply content + sender details

    IF intent = "info_request":
      → outlook_send_email
         to: marketing@medicodio.site
         subject: "[Reply] {Sender Name} asked a question — review needed"
         body: "{Sender Name} ({Company}) replied with a question.
                Their message: {reply body}
                Please review and respond or I will draft a follow-up."

    IF intent = "not_interested":
      → no email, just audit

    IF intent = "out_of_office":
      → no email, just audit

0e. Update Excel for each matched row:
    sharepoint_excel_write_range
    → set paperclip_status="replied" (or "demo_interest" if that intent)
    → set paperclip_reply_at="{now ISO}"
    → set paperclip_reply_intent="{classified intent}"
    → set paperclip_reply_summary="{one-line summary}"

0f. Post summary comment on current issue:
    "Reply check complete. {N} replies found.
     Demo interest: {count} | Info requests: {count} | Not interested: {count} | OOO: {count}"
```

**How to match reply to Excel row:**
Search Excel for rows where `paperclip_status = "sent"` and `Email` matches the reply sender email. If no match found, log in run-log but skip Excel update.

---

### PHASE 1 — Load config

```
1. sharepoint_read_file path="Marketing-Specialist/config.md"
   → parse apollo_file, batch_size, review_email, outlook_user
   → if file missing: use defaults from table above, create config.md with defaults
```

### PHASE 2 — Read Apollo CSV and find next batch

```
2. sharepoint_get_file_info path="{apollo_file}"
   → if not found: post issue comment "Apollo file '{apollo_file}' not found at SharePoint root. Blocked."
   → update issue status → blocked, STOP

3. sharepoint_excel_read_range filePath="{apollo_file}" sheetName="{apollo_sheet}" address=""
   → read all rows into memory

4. Find next {batch_size} rows where paperclip_status is empty or missing
   → skip rows where paperclip_status = "draft_created" | "sent"
   → if zero unprocessed rows found:
       post comment "All leads processed. No rows to action."
       update issue → done, STOP
```

### PHASE 3 — Research each lead

**REQUIRED: Invoke the `web-research` skill before starting any research.** Do not free-form search. The skill defines the exact tool sequence, fallback order, and cross-verification rules.

```
Skill: web-research
→ General Research Pattern for company overview
→ Contact Research Pattern if email is missing
```

For each row in the batch:

```
5. Invoke web-research skill → General Research Pattern:
   Queries to run:
   - "{First Name} {Last Name} {Company Name}" — person overview
   - "{Company Name} recent news 2025 2026" — announcements
   - "{Company Name} ambulatory surgery center medical coding" — relevance hook

   Tool order per web-research skill:
   a. duckduckgo search each query (do NOT use brave-search — no key)
   b. fetch company homepage + /about + /team if duckduckgo returns thin results
   c. apify/rag-web-browser if fetch still thin — THEN get-actor-output datasetId limit=20

6. Build research summary for this lead:
   - Full name + title
   - Company: what it does (1-2 sentences, healthcare/ASC focus)
   - Recent news / announcements (if any found)
   - Personalisation hook: ONE specific detail to open the email with
   - If NO research found after all tools: note "no research — use generic template"
```

### PHASE 4 — Draft emails

For each researched lead:

```
8. Compose subject:
   "Connecting at ASCA + SAMBA — Medicodio AI"

9. Compose full HTML body — EXACTLY this structure, no plain text fallback ever:

   REPLACE {First Name}, {personalisation_hook}, {value_prop}, {Company Name} with actual values.
   If no research found, use generic fallback values marked below.
```

```html
<p>Hi {First Name},</p>

<p>With ASCA + SAMBA coming up May 13–16 in Washington, DC, I wanted to introduce Medicodio.</p>

<p>We're an AI-powered medical coding platform built specifically for Ambulatory Surgery Centers.</p>

<p>Many ASCs we speak with rely on small coding teams to manage the entire revenue cycle. That works — until someone leaves, volumes spike, or a new surgeon joins. By the time issues surface as denials, weeks of revenue may already be lost.</p>

<p>Medicodio is designed to prevent that. We can either fully handle coding on your behalf or support your existing coders with an AI platform that works alongside them, with built-in compliance checks before any claim is submitted.</p>

<p>We're trusted by 50+ healthcare providers, including ASCs.</p>

<p>We'll be at ASCA and would love to meet in person. Find us at booth #932 — stop by anytime during the conference and let's connect.</p>

<br><br>
<table cellpadding="0" cellspacing="0" border="0" style="font-family: Arial, Helvetica, sans-serif; color:#333333; line-height:1.5; border-left:3px solid #0a1d56; padding-left:16px;">
  <tr><td>
    <table cellpadding="0" cellspacing="0" border="0">
      <tr><td style="font-family: Arial, Helvetica, sans-serif; font-size:14px; color:#0a1d56; font-weight:700; padding-bottom:2px;">Thanks &amp; Regards,</td></tr>
      <tr><td style="font-family: Arial, Helvetica, sans-serif; font-size:16px; color:#0a1d56; font-weight:700; padding-bottom:4px;">Medicodio</td></tr>
      <tr><td style="font-family: Arial, Helvetica, sans-serif; font-size:12px; color:#666666; padding-bottom:10px; letter-spacing:0.3px; text-transform:uppercase;">AI Powered Medical Coding</td></tr>
      <tr><td style="font-family: Arial, Helvetica, sans-serif; font-size:13px; color:#333333; padding-top:8px; border-top:1px solid #e5e7eb;">
        <a href="https://medicodio.ai/" style="color:#0a1d56; text-decoration:none; font-weight:600;" target="_blank">MediCodio AI</a>
        <span style="color:#c0c5d1; padding:0 6px;">|</span>
        <a href="https://www.linkedin.com/company/medicodioai/" style="color:#0a1d56; text-decoration:none; font-weight:600;" target="_blank">LinkedIn</a>
        <span style="color:#c0c5d1; padding:0 6px;">|</span>
        <a href="mailto:marketing@medicodio.site" style="color:#0a1d56; text-decoration:none; font-weight:600;">marketing@medicodio.site</a>
      </td></tr>
    </table>
  </td></tr>
</table>
```

```
10. outlook_create_draft
    → mailbox: marketing@medicodio.site
    → subject: composed subject (step 8)
    → body: full HTML from step 9 (with all placeholders replaced)
    → bodyType: "HTML"   ← REQUIRED — never omit, never use "Text"
    → toRecipients: [{lead email address}]
    → save returned draft message ID

11. sharepoint_excel_write_range
    → update this row: paperclip_status="draft_created", paperclip_draft_id="{draftId}", paperclip_processed_at="{now ISO}"
```

### PHASE 5 — Notify reviewer

```
11. Compose summary of all drafts created this run:
    - Table: First Name | Last Name | Company | Draft created ✓
    - List of Outlook draft IDs

12. outlook_send_email
    → to: {review_email}
    → subject: "[Medicodio Outreach] {batch_size} email drafts ready for review — {today date}"
    → body:
       "Hi Karthik,

        I've drafted {N} outreach emails and saved them to your Outlook Drafts folder.

        Leads processed today:
        {table of names + companies}

        To send: go to Paperclip issue #{issueId} and click Approve.
        To skip: reject the approval in Paperclip with a note.

        The emails will be sent automatically once you approve.

        — Marketing Specialist"
```

### PHASE 6 — Create Paperclip approval and pause

```
13. Create approval on current issue:
    → title: "Review and approve {N} outreach email drafts — {date}"
    → body: list each lead name + company + Outlook draft ID
    → required approver: marketing@medicodio.site user

14. Post issue comment:
    "Draft emails created for {N} leads. Approval requested from @karthik.
     Awaiting review before sending. Draft IDs: {comma-separated list}"

15. Update issue status → "waiting" or leave open
    → routine will skip_if_active until this issue closes
```

---

## PHASE 7 — On approval (same issue, resuming)

When Karthik approves the Paperclip approval:

```
16. Agent receives approval notification via heartbeat

17. Read the approval body to extract draft IDs

18. For each draft ID:
    outlook_send_draft messageId="{draftId}"
    → on success: note sent
    → on error: note failure, continue others

19. sharepoint_excel_write_range
    → for each sent row: paperclip_status="sent", paperclip_processed_at="{now ISO}"
    → for any failed: paperclip_status="send_failed", paperclip_notes="{error}"

20. outlook_send_email
    → to: {review_email}
    → subject: "[Medicodio Outreach] {N} emails sent successfully — {date}"
    → body: "All approved drafts have been sent. Summary: {names + companies}"

21. Post final comment on issue:
    "All {N} emails sent. Rows updated in Apollo sheet. Closing issue."

22. Update issue → done
```

---

## On rejection (Karthik rejects approval)

```
16b. Agent receives rejection notification

17b. Read rejection reason from approval comment

18b. sharepoint_excel_write_range
     → for each row in batch: paperclip_status="skipped", paperclip_notes="{rejection reason}"

19b. Post comment: "Approval rejected. Reason: {reason}. Rows marked skipped."

20b. Update issue → done
```

---

## Error handling

| Situation | Action |
|-----------|--------|
| Apollo file not found | Set issue → blocked, comment with exact filename tried |
| Row missing email | Set `paperclip_status="skipped"`, `paperclip_notes="no email"`, continue |
| Web search returns nothing | Draft email without company detail, note in draft body |
| Outlook draft creation fails | Set `paperclip_status="error"`, note error, continue other rows |
| Send fails on approval | Mark that row `send_failed`, send others, report in comment |

---

## SharePoint folder for this agent

All working files live under `Marketing-Specialist/` in SharePoint:

```
Marketing-Specialist/
├── config.md              ← runtime config (apollo_file, batch_size, etc.)
├── research/
│   └── YYYY-MM-DD/        ← research notes per run date
│       ├── {FirstName}-{LastName}.md
└── run-logs/
    └── YYYY-MM-DD.md      ← per-run summary log
```

Write a run log at end of each run:

```
sharepoint_write_file path="Marketing-Specialist/run-logs/{YYYY-MM-DD}.md"
content: date, rows processed, draft IDs, status, any errors
```
