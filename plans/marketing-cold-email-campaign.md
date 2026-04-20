# Implementation Plan: ASC Cold Email Campaign Routine
## Marketing Specialist Agent — Autonomous Daily Campaign

---

## Overview

Automated cold email outreach targeting ASC (Ambulatory Surgery Centers) for Medicodio AI's medical coding services. Marketing Specialist agent runs daily: researches each contact via web, writes hyper-personalised emails, warms 2 domains gradually, tracks everything in a master Excel audit file on SharePoint, monitors replies, sends follow-ups, and handles bounces with fallback email discovery.

**What makes this different from spam:**
- Every email references something real and recent about that specific person/org
- Value proposition is concrete: AI medical coding that saves them money/time
- Volume controlled (domain warming = deliverability)
- Full audit trail per contact

---

## Architecture Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Contact data source | SharePoint apollo-contacts-export.xlsx | Already there, 5 versions |
| Master tracker | Single Excel file in SharePoint `Campaigns/ASC-2026/master-tracker.xlsx` | Agent reads/writes via Graph Excel API |
| Web research | Playwright browser + DuckDuckGo/Google | No API key needed, real results |
| Email fallback | Apollo API (future) → Hunter.io → web search | Layered, resilient |
| Domain warming | Start 10/day per domain, +10/week | Industry standard safe ramp |
| Reply detection | Outlook `outlook_search_emails` daily | Existing MCP, works now |
| Dedup guard | Check master Excel before every send | Prevents double-sending |
| Routine trigger | Cron: 8:00 AM weekdays | Before business day starts |

---

## Master Excel Structure

**File:** `Campaigns/ASC-2026/master-tracker.xlsx`

### Sheet 1: `Contacts` (master list)

| Column | Values | Notes |
|--------|--------|-------|
| contact_id | UUID | Dedup key |
| first_name | text | |
| last_name | text | |
| full_name | text | |
| title | text | e.g. "RCM Director" |
| company | text | ASC name |
| email | text | Primary email |
| email_status | valid / invalid / bounced / unknown | Updated on send |
| alt_email | text | Found via fallback search |
| domain_assigned | domain1 / domain2 | Balanced assignment |
| status | pending / researched / drafted / sent / replied / followup1 / followup2 / done / dnc | Pipeline stage |
| research_notes | text | What agent found |
| hook_used | text | Personalisation hook in email |
| draft_id | text | Outlook draft message ID |
| sent_date | date | |
| sent_from | email address | Which sending domain |
| opened | true/false | If tracking available |
| replied | true/false | |
| reply_date | date | |
| reply_summary | text | What they said |
| followup1_sent | true/false | |
| followup1_date | date | |
| followup2_sent | true/false | |
| followup2_date | date | |
| bounced | true/false | |
| bounce_reason | text | |
| fallback_attempted | true/false | Tried Apollo/Hunter |
| notes | text | Any manual notes |
| last_updated | datetime | Agent updates on every action |

### Sheet 2: `Domain1-Log`
Columns: date, contact_id, email_to, subject, type (initial/followup1/followup2/reply), status (sent/failed), message_id

### Sheet 3: `Domain2-Log`
Same as Domain1-Log

### Sheet 4: `Replies`
Columns: date_received, contact_id, from_email, subject, body_preview, response_drafted, response_sent, outcome (interested/not_interested/wrong_person/bounced)

### Sheet 5: `Bounces`
Columns: date, contact_id, original_email, bounce_type (hard/soft), fallback_attempted, alt_email_found, resolution

### Sheet 6: `DNC` (Do Not Contact)
Columns: email, company, reason, date_added

### Sheet 7: `Domain-Warmup-Log`
Columns: date, domain, sends_today, cumulative_sends, week_number, limit_today

---

## Domain Warming Schedule

```
Week 1 (now):    10/day per domain = 20 total/day
Week 2:          20/day per domain = 40 total/day
Week 3:          30/day per domain = 60 total/day
Week 4:          40/day per domain = 80 total/day
Month 2+:        50/day per domain = 100 total/day
```

Agent checks Domain-Warmup-Log to know today's limit before sending.

---

## Email Templates (Agent Generates Per-Contact)

### Initial Email Structure
```
Subject: [hook from research — NOT "partnership" or "quick question"]
        e.g. "Re: [Company]'s transition to new CPT codes for [procedure]"

Body (< 150 words):
  Line 1: Reference what you found — specific, real, recent
           "Saw [Company] recently expanded its [procedure] volume — 
            congrats on the growth."
  
  Line 2: Relevant pain that growth creates
           "At that scale, coding accuracy on [specific code set] 
            becomes critical — one denial wave can erase a quarter."
  
  Line 3: What Medicodio does — one sentence, concrete
           "We built AI that cuts ASC coding denials by ~40% — 
            specifically for [procedure type] centres."
  
  Line 4: Soft CTA — not "book a call", something lower friction
           "Worth a 5-min read? Sending our ASC benchmark report."
  
  Sign-off: [Sender name], Medicodio AI
```

### Follow-up 1 (Day 4, if no reply)
```
Short. Different angle. No "just following up".
Reference a new data point or question about their situation.
< 80 words.
```

### Follow-up 2 (Day 10, if no reply)
```
Final touch. Give value, ask nothing.
Share one relevant insight specific to their ASC type.
< 60 words.
"No reply needed — just thought this was relevant to [Company]."
```

### Reply Response
```
Within same day. Reference exactly what they said.
If interested: offer specific next step (call, demo, report).
If not interested: thank them, ask what their current solution is (intel).
If wrong person: ask who handles coding/RCM, get warm intro.
```

---

## Task Breakdown

### Phase 1: Data Preparation (One-time setup)

**Task 1: Read + Deduplicate Contact Data**
- Description: Read all 5 apollo-contacts-export xlsx files from SharePoint, merge, deduplicate by email, filter for ASC/surgery centre titles (RCM Director, Coding Manager, Revenue Cycle, CFO, COO, Administrator)
- Acceptance criteria:
  - [ ] All 5 files read via `sharepoint_excel_read_range`
  - [ ] Duplicates removed (by email)
  - [ ] Non-ASC contacts filtered out
  - [ ] Output: clean contact list
- Files: `apollo-contacts-export-v5.xlsx` (latest, 948k = most data)

**Task 2: Create Master Tracker Excel**
- Description: Create `Campaigns/ASC-2026/master-tracker.xlsx` in SharePoint with all sheets and headers. Populate Contacts sheet from Task 1 output.
- Acceptance criteria:
  - [ ] File created in SharePoint
  - [ ] All 7 sheets created with correct headers
  - [ ] Contacts sheet populated
  - [ ] All status = "pending" initially
  - [ ] Domains assigned alternately (domain1/domain2) for load balancing
- Tools: `sharepoint_create_folder`, `sharepoint_excel_add_sheet`, `sharepoint_excel_write_range`

**Task 3: Initialise Domain Warmup Log**
- Description: Write Week 1 limits to Domain-Warmup-Log sheet. Set today's limit = 10 per domain.
- Acceptance criteria:
  - [ ] Domain-Warmup-Log has today's entry
  - [ ] Limits correct for week number

---

### Phase 2: Daily Routine Core Loop

**Task 4: Reply Monitor**
- Description: Each morning, search Outlook inbox for replies to campaign emails. Match to master tracker by sender email. Update Excel. Draft response.
- Acceptance criteria:
  - [ ] `outlook_search_emails` query targets campaign subject patterns
  - [ ] Each reply matched to contact_id in Excel
  - [ ] Excel updated: replied=true, reply_date, reply_summary
  - [ ] Reply added to Replies sheet
  - [ ] Response drafted via `outlook_create_draft` within same session
  - [ ] Paperclip comment posted with reply summary
- Edge cases:
  - Reply from unknown email → search Excel by company domain
  - Out-of-office → mark, don't respond, re-queue after 7 days
  - Unsubscribe request → add to DNC sheet, never contact again

**Task 5: Bounce Detection**
- Description: Check Outlook sent/drafts for delivery failure notifications. Parse bounced email address. Update Excel.
- Acceptance criteria:
  - [ ] Bounce emails detected (subject contains "Delivery failed", "Undeliverable", "bounce")
  - [ ] Parsed: which email address failed
  - [ ] Excel updated: bounced=true, bounce_reason
  - [ ] Contact queued for fallback email discovery (Task 6)

**Task 6: Fallback Email Discovery**
- Description: For bounced/invalid emails, attempt to find correct email via web search and (later) Apollo API.
- Acceptance criteria:
  - [ ] Web search: `"{first_name} {last_name} {company} email"` via Playwright browser
  - [ ] Web search: `site:linkedin.com "{first_name} {last_name}" "{company}"` 
  - [ ] If found: update alt_email in Excel, reset status to pending
  - [ ] If not found after 3 attempts: mark permanently_invalid
  - [ ] Log all attempts in Bounces sheet
  - [ ] Apollo API (when available): `apollo_search_person name company` as primary fallback
- Edge cases:
  - Multiple emails found → pick most recent/professional
  - Only LinkedIn found (no email) → mark for manual review, flag in Paperclip

**Task 7: Contact Research Pipeline**
- Description: For each contact in status=pending, run web research to find personalisation hook.
- Acceptance criteria:
  - [ ] Playwright browser search: `"{name}" "{company}" medical coding OR RCM OR ASC 2025 OR 2026`
  - [ ] Playwright browser search: `"{company}" ambulatory surgery center news`
  - [ ] Playwright browser search: `"{name}" LinkedIn profile`
  - [ ] Synthesise: find 1 specific recent fact (new procedure, expansion, award, challenge, regulation change affecting them)
  - [ ] If nothing found: use company-level hook (ASC type, location, specialty)
  - [ ] Update Excel: research_notes, status=researched
- Edge cases:
  - No results found → use generic ASC hook (acceptable, note in Excel)
  - Paywalled content → skip, use snippet preview only
  - Search rate limit → add 2s delay between searches, batch max 10 per run

**Task 8: Email Drafting**
- Description: For each researched contact, write personalised email using research hook. Create Outlook draft.
- Acceptance criteria:
  - [ ] Email uses specific research hook from Task 7
  - [ ] Subject line does NOT contain "partnership", "quick question", "following up"
  - [ ] Body < 150 words
  - [ ] References specific fact about their ASC/role
  - [ ] CTA is low-friction (read a report, not "book a call")
  - [ ] `outlook_create_draft` called with correct from address (domain1 or domain2 per assignment)
  - [ ] Draft ID stored in Excel: draft_id, status=drafted
- Edge cases:
  - Draft creation fails → log error, retry once, then mark for manual
  - Contact has no research → use company-level personalisation

**Task 9: Send Batch (Domain Limit Enforced)**
- Description: Send drafted emails respecting daily domain warming limits.
- Acceptance criteria:
  - [ ] Read Domain-Warmup-Log: how many already sent today per domain
  - [ ] Calculate remaining budget: limit - already_sent
  - [ ] Send only up to budget (never exceed)
  - [ ] `outlook_send_draft` for each
  - [ ] Excel updated: status=sent, sent_date, sent_from
  - [ ] Domain log updated: +1 to sends_today
- Edge cases:
  - Budget exhausted for domain → stop, queue remaining for tomorrow
  - Send fails (API error) → mark draft_send_failed, retry tomorrow
  - Wrong domain chosen → check domain assignment before send

**Task 10: Follow-up Queue Processing**
- Description: Daily check for contacts due for follow-up. Draft and send follow-up emails.
- Acceptance criteria:
  - [ ] Follow-up 1: status=sent AND sent_date <= today-4 AND replied=false AND followup1_sent=false
  - [ ] Follow-up 2: followup1_sent=true AND followup1_date <= today-6 AND replied=false AND followup2_sent=false
  - [ ] Different email copy per follow-up (not same message again)
  - [ ] Respects domain daily limits (counted together with initial sends)
  - [ ] Excel updated: followup1_sent, followup1_date OR followup2_sent, followup2_date
- Edge cases:
  - Contact replied between follow-ups → skip, already handled by Task 4
  - Contact in DNC → never send, skip silently
  - Domain limit hit → defer follow-ups, initial sends get priority

**Task 11: EOD Audit Update**
- Description: End of routine — update master Excel summary, write daily report to SharePoint.
- Acceptance criteria:
  - [ ] Count: sent today, replied (new), bounced, follow-ups sent, research completed
  - [ ] Write report: `Reports/campaign/YYYY-MM-DD-campaign-report.md`
  - [ ] Post Paperclip issue comment with summary
  - [ ] Update domain warmup log with final day count
  - [ ] Flag if approaching weekly limit (>80% of limit)

---

### Phase 3: Edge Case Handlers

**Task 12: DNC Enforcement**
- Description: Before every send (initial + follow-up), check DNC sheet. Hard block.
- Acceptance criteria:
  - [ ] DNC checked by email AND company domain
  - [ ] If match: skip silently, log in notes
  - [ ] Unsubscribe replies auto-add to DNC (from Task 4)
  - [ ] Manual DNC entries respected

**Task 13: Duplicate Send Prevention**
- Description: Before `outlook_send_draft`, verify contact not already sent today.
- Acceptance criteria:
  - [ ] Check Domain log: no send to this email in past 24h
  - [ ] Check Contacts sheet: status not already = sent/done
  - [ ] If duplicate detected: skip, log warning in Paperclip comment

**Task 14: Domain Reputation Guard**
- Description: If bounce rate > 10% for a domain today, pause that domain.
- Acceptance criteria:
  - [ ] After each batch: calculate bounce_rate = bounces_today / sends_today
  - [ ] If > 10%: stop sending from that domain for 48h
  - [ ] Update Domain-Warmup-Log: paused=true, pause_until=today+2
  - [ ] Post Paperclip alert comment

---

### Phase 4: Future Additions (Post-MVP)

**Task 15: Apollo API Integration**
- Description: When Apollo MCP available, use as primary email fallback before web search.
- Dependencies: Apollo API key + mcp-apollo package built
- Flow: bounce detected → apollo_search_person → if found update Excel → continue

**Task 16: Email Open Tracking**
- Description: If tracking pixel added to emails, read open events from Outlook/webhook.
- Dependencies: Email tracking service (Mailtrack, HubSpot, etc.)

**Task 17: Per-Agent Mailboxes**
- Description: Marketing agent sends from `marketing@medicodio.ai` not `karthik.r@medicodio.ai`
- Dependencies: Mailbox created in M365

---

## Routine Configuration

```
Name:     ASC Cold Email Campaign
Agent:    Marketing Specialist
Schedule: 0 8 * * 1-5  (8:00 AM, Mon-Fri)
Catchup:  false  (don't run missed days)
Concurrency: 1  (never run parallel)

Issue title template: 
  "Campaign Run — {date} — ASC Cold Email"

Issue description:
  "Daily campaign routine. Check replies → process bounces → 
   research batch → draft → send → update tracker → EOD report."
```

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Domain blacklisted | Campaign stops | Stay under limits, bounce guard, warmup schedule |
| Wrong person gets email | Reputation damage | Research step confirms role before send |
| Double send | Spam complaint | Duplicate guard checks Excel before every send |
| Excel corrupted | Data loss | SharePoint versioning auto-saves all edits |
| Reply missed | Lost opportunity | Search Outlook daily, not just check folder |
| Search rate limits | Research stops | 2s delay between searches, batch max 10 |
| Unsubscribe ignored | Legal risk | DNC list enforced hard before every send |
| Apollo not available | No email fallback | Web search fallback always runs first |
| Claude hits Claude Code 25/day limit | Routine skips | Schedule only 1 routine, keep it within limit |

---

## Open Questions (Need Human Input)

1. **2 domain names** — what are the actual sending domains being warmed? Need to configure `outlook_create_draft` with correct from addresses.
2. **Reply authority** — can agent send replies autonomously, or draft for human review first?
3. **Medicodio value prop** — exact details: what does the AI coding product do, pricing, target customer size?
4. **CTA asset** — what's the "ASC benchmark report" or asset to offer in CTA?
5. **Follow-up limit** — after follow-up 2 with no reply, permanently archive or re-queue in 90 days?
6. **Apollo API key** — for email discovery fallback (bring tomorrow)
7. **Greythr URL + HR creds** — separate but needed for HR routines

---

## Implementation Order (Tomorrow)

```
Day 1 (Tomorrow):
  Task 1  → Read + deduplicate contacts              [30 min]
  Task 2  → Create master tracker Excel              [20 min]
  Task 3  → Init domain warmup log                  [10 min]
  Task 4  → Reply monitor routine                   [30 min]
  Task 5  → Bounce detection                        [20 min]
  Task 12 → DNC enforcement                         [15 min]
  Task 13 → Duplicate guard                         [15 min]
  
  ── Checkpoint: Data layer working ──
  
  Task 7  → Research pipeline                       [45 min]
  Task 8  → Email drafting                          [30 min]
  Task 9  → Send batch + domain limits              [30 min]
  Task 10 → Follow-up queue                         [20 min]
  Task 11 → EOD report                              [15 min]
  
  ── Checkpoint: Full loop working ──
  
  Task 6  → Bounce fallback (web search)            [30 min]
  Task 14 → Domain reputation guard                 [15 min]
  
  ── Set up Paperclip routine (cron) ──
  ── Test run: 2 contacts end-to-end ──
  
Day 2+:
  Task 15 → Apollo integration (when key available)
  Task 16 → Open tracking
  Task 17 → Agent mailboxes
```
