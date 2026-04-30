# Event Outreach Routine

**Trigger:** Manual — create a Paperclip issue assigned to `marketing-specialist` to fire this routine  
**Concurrency policy:** `skip_if_active` — one event run at a time  
**Catch-up policy:** `skip_missed`

---

## Overview

Generic, reusable conference/event outreach module. All event-specific data lives in SharePoint config — zero code changes needed per event. Handles missing email discovery via Hunter.io before sending. Processes attendees in configurable batches with a sufficiency gate before sending.

---

## MANDATORY EXECUTION ORDER

**Every run MUST execute ALL phases below in sequence. Never stop between phases.**
Early exit is ONLY permitted at an explicit STOP instruction listed under STOP CONDITIONS.

| Step | Phase | Skip condition |
|------|-------|----------------|
| 1 | PRE-CHECK A — Delivery status (bounces) | None — always run |
| 2 | PRE-CHECK B — Reply detection | None — always run |
| 3 | PHASE 0 — Read config | None — always run |
| 4 | PHASE 1 — Load batch + column map | None — always run |
| 5 | PHASE 2 — Hunter email enrichment | Skip only if `need_email` list is empty |
| 6 | PHASE 3 — Sufficiency check | None — always run |
| 7 | PHASE 4 — Compose and send / draft emails | None — always run |
| 8 | PHASE 5 — Write audit columns back to Excel | None — always run |
| 9 | PHASE 6 — Notify reviewer | Skip only if `send_mode = direct` |
| 10 | PHASE 7 — On approval / rejection | Skip only if `send_mode = direct` |
| 11 | PHASE 8 — Run log and summary | None — always run |

## STOP CONDITIONS

Early exit is ONLY permitted when one of these explicit conditions is met:

- `event_slug` missing from issue description → post blocked comment, STOP
- `config.md` not found in SharePoint → post blocked comment, STOP
- Required config keys missing → post blocked comment listing missing keys, STOP
- `pc_status` column mapping error detected → post blocked comment, STOP
- Zero eligible rows found → post "Nothing to do" comment, close issue, STOP
- Unrecoverable SharePoint write error → escalate, STOP

**Everything else → continue immediately to the next phase.**

---

## Global Conventions

- **Timestamps:** ISO-8601 UTC — `YYYY-MM-DDTHH:MM:SSZ`
- **SharePoint base:** `Marketing-Specialist/event-outreach/{event_slug}/`
- **Config file:** `Marketing-Specialist/event-outreach/{event_slug}/config.md` (read on every run — always fresh)
- **HTML emails:** All emails MUST use `bodyType: "HTML"` or `isHtml: true`. Never plain text.
- **Audit columns:** Written back to the same Excel file. Never modify input data columns.
- **Excel reads — NEVER read unbounded ranges.** Rules in order:
  1. Read header row (`A1:ZZ1`) first to find column letters.
  2. Determine `last_row` by reading a single column with a ceiling: `{col}1:{col}2000`, count non-empty cells.
  3. Always use row-bounded addresses: `{start_col}1:{end_col}{last_row}`. NEVER use `BV:CK`-style unbounded column ranges.
  4. Read at most 3–4 adjacent columns per call. Non-adjacent columns → separate single-column reads.
  5. Full-sheet reads and wide unbounded ranges cause token overflow on large files.
- **Hunter API key:** Read from env var `HUNTER_API_KEY` — never hardcode.
- **Idempotency:** Row is skipped if ANY of these are true:
  - `pc_status` = `sent` / `draft_created` / `skipped` (this event's audit columns), OR
  - `email_delivery_status` = `sent` (pre-existing column from prior system — never reprocess)
  Never re-draft or re-send to a row already marked sent by any system.

---

## SharePoint Folder Structure

Each event gets its own isolated folder. No shared config — no cross-event collision.

```
Marketing-Specialist/
└── event-outreach/
    ├── asca-samba-2026/
    │   ├── config.md                    ← edit this per event (14 fields)
    │   ├── email-template.html          ← full email body, edit per event
    │   ├── column-map.md               ← auto-generated on first run, never touch
    │   ├── asca-samba-2026.xlsx         ← attendee list
    │   └── run-logs/
    │       └── 2026-04-28.md
    ├── himss-2027/                      ← next event, identical structure
    │   ├── config.md
    │   ├── email-template.html
    │   ├── column-map.md
    │   ├── himss-2027.xlsx
    │   └── run-logs/
    │       └── 2026-10-15.md
    └── ...
```

**Config path per event:** `Marketing-Specialist/event-outreach/{event_slug}/config.md`  
**Attendee file path:** `Marketing-Specialist/event-outreach/{event_slug}/{attendee_file}`  
**Run logs path:** `Marketing-Specialist/event-outreach/{event_slug}/run-logs/{YYYY-MM-DD}.md`

The routine derives all paths from `event_slug` in config — you never hardcode a path.

---

## Excel Columns

### Column map — parsed once, cached per event

The agent does NOT assume column names. On first run it reads all headers, infers which column maps to which field, stores the result in SharePoint. Every subsequent run loads the cached map — no re-detection.

**Cached file:** `Marketing-Specialist/event-outreach/{event_slug}/column-map.md`

```markdown
# Column Map — {event_slug}
# Auto-generated on first run. Edit manually only if headers change.
# Format: canonical_field: exact_header_as_it_appears_in_excel | column_index
# IMPORTANT: column_index is 0-BASED. A=0, B=1, C=2, ... Z=25, AA=26, AB=27, ...
# Conversion formula: index < 26 → single letter (A+index); index >= 26 → two letters (AA=26, AB=27, ...)

first_name:  First Name   | 0
last_name:   Last Name    | 1
email:       Email        | 2
company:     Company Name | 3
domain:      Website      | 4     ← optional, absent = -1
title:       Job Title    | 5     ← optional, absent = -1
```

### Canonical field inference rules (used only on first run)

| Canonical field | Match any of these (case-insensitive, partial ok) |
|-----------------|---------------------------------------------------|
| `first_name` | first name, firstname, fname, given name, first |
| `last_name` | last name, lastname, lname, surname, family name, last |
| `email` | email, e-mail, email address, work email, contact email |
| `company` | company, company name, organization, organisation, employer, account, firm |
| `domain` | domain, website, url, web, site |
| `title` | title, job title, jobtitle, position, role, designation |
| `prior_delivery_status` | email_delivery_status, delivery_status, mail_delivery_status, send_status |

Required canonical fields: `first_name`, `last_name`, `company`  
Optional: `email` (Hunter fills if absent), `domain`, `title`, `prior_delivery_status` (prior system sent flag)

### Audit columns (agent writes — auto-created on first run)

| Column | Values |
|--------|--------|
| `pc_status` | `pending` → `sent` / `draft_created` / `email_not_found` / `skipped` / `error` |
| `pc_email_source` | `original` / `hunter` / `none` |
| `pc_email_used` | Final email address used (original or Hunter-found) |
| `pc_draft_created_at` | ISO timestamp when draft was created in Outlook |
| `pc_sent_at` | ISO timestamp when email was actually sent (filled on approval/send — blank until then) |
| `pc_event` | `{event_slug}` from config — links row to specific event |
| `pc_draft_id` | Outlook draft message ID (only if `send_mode: draft_review`) |
| `pc_hunter_confidence` | Hunter confidence score (0–100) if Hunter was used |
| `pc_hunter_method` | `email_finder` / `domain_search` / `none` — which Hunter method found the email |
| `pc_email_risk` | `deliverable` / `risky` / `undeliverable` — Hunter verify result |
| `pc_notes` | Error detail or skip reason |
| `pc_delivery_status` | `delivered` / `bounced` — filled by PRE-CHECK A after 24hrs |
| `pc_delivery_notes` | Bounce reason (first 200 chars of NDR) |
| `pc_reply_received` | `yes` / blank — filled by PRE-CHECK B |
| `pc_reply_intent` | `demo_interest` / `out_of_office` / `positive` / `negative` / `neutral` |
| `pc_reply_snippet` | First 100 chars of reply body |

---

## PRE-CHECK A — Delivery Status (bounces for rows sent >24hrs ago)

Run this before anything else. Updates Excel with bounce data from prior sends.

```
A1. Read event_slug from issue description (same as Phase 0 — needed for file paths).
    If missing, skip pre-checks and go straight to Phase 0.

A2. Read ONLY audit columns — never read the full sheet (full read = token overflow).
    ALWAYS use row-bounded ranges. NEVER use unbounded column addresses like "BV:CK".

    STEP 1: Read header row only to find audit column letters:
    sharepoint_excel_read_range
    → address: "A1:ZZ1"   ← header row only, all columns
    → find index of: pc_status, pc_event, pc_email_used, pc_sent_at, pc_delivery_status, pc_delivery_notes
    → convert index to Excel column letter (A=0, B=1, ... Z=25, AA=26, ...)

    STEP 2: Determine last data row — read pc_status column only with a ceiling:
    sharepoint_excel_read_range
    → address: "{pc_status_col}1:{pc_status_col}2000"   ← single column, capped at 2000
    → count non-empty cells (excluding header) → last_row

    If last_row = 0: skip to PRE-CHECK B (no data rows).

    STEP 3: Read pc_status + pc_event only to find candidate rows:
    sharepoint_excel_read_range
    → address: "{pc_status_col}1:{pc_event_col}{last_row}"   ← 2 columns, row-bounded
    → collect row numbers where pc_status = "sent" AND pc_event = {event_slug}

    If none: skip to PRE-CHECK B.

    STEP 4: Read delivery columns only for candidate rows — 3 columns max, row-bounded:
    sharepoint_excel_read_range
    → address: "{pc_email_used_col}1:{pc_delivery_notes_col}{last_row}"   ← 3 columns, row-bounded
    → filter to candidate rows where pc_delivery_status is empty (not yet checked)

    Check every sent row regardless of when it was sent — no 24hr restriction.
    If none: skip to PRE-CHECK B.

A3. For each such row:
    Check Outlook inbox for bounce/NDR:
    outlook_search_mail
    → mailbox: {outlook_user}
    → query: "from:mailer-daemon OR from:postmaster {pc_email_used}"
    → look for bounce/NDR referencing that email address

    If bounce found in Outlook:
    → pc_delivery_status = "bounced"
    → pc_delivery_notes = bounce reason (first 200 chars of NDR body)
    → continue to next row

    If no Outlook bounce found:
    → pc_delivery_status = "delivered"
    → pc_delivery_notes = blank

A4. sharepoint_excel_write_range → write pc_delivery_status + pc_delivery_notes for updated rows

A5. Post comment:
    "PRE-CHECK A: {delivered_count} delivered, {bounced_count} bounced, {skipped_count} skipped (< 24hrs or already checked)."

    → NEXT: Proceed immediately to PRE-CHECK B. Do not stop.
```

---

## PRE-CHECK B — Reply Detection (scan inbox for replies)

```
B1. Read ONLY pc_email_used + pc_reply_received columns (never full sheet).
    ALWAYS use row-bounded ranges. NEVER use unbounded column addresses.

    NOTE: last_row here is from pc_status column (only processed rows) — that is correct for
    PRE-CHECK B since we only scan emails that were actually sent.
    Reuse last_row from PRE-CHECK A if available; otherwise re-read:
    sharepoint_excel_read_range
    → address: "{pc_status_col}1:{pc_status_col}2000"   ← single column, capped at 2000
    → count non-empty cells (excluding header) → last_row

    sharepoint_excel_read_range
    → address: "{pc_email_used_col}1:{pc_reply_received_col}{last_row}"   ← 2 columns, row-bounded
    → collect all pc_email_used values where pc_reply_received is empty

    Then scan Outlook inbox:
    outlook_list_messages
    → mailbox: {outlook_user}
    → folder: Inbox
    → filter: last 7 days
    → Look for emails whose sender address matches any collected pc_email_used value

B2. For each matching reply:
    Read subject + first 500 chars of body.

    Classify intent:
    → "demo_interest"   — mentions demo, meeting, call, interested, learn more, schedule
    → "unsubscribe"     — unsubscribe, remove me, opt out, stop emailing
    → "out_of_office"   — out of office, OOO, away, vacation, maternity/paternity
    → "positive"        — thanks, looks good, great, will share, forwarding
    → "negative"        — not interested, no thanks, wrong person, irrelevant
    → "neutral"         — everything else

B3. Write reply status back to Excel:
    sharepoint_excel_write_range
    → pc_reply_received = "yes"
    → pc_reply_intent   = {classified intent}
    → pc_reply_snippet  = first 100 chars of reply body

B4. For any row classified as "demo_interest":
    resend_send_email
    → from: {outlook_user}
    → to: {review_email}
    → subject: "[{event_name}] Demo interest — {first_name} {last_name} ({company})"
    → html:
      <p><strong>{first_name} {last_name}</strong> ({title}, {company}) replied with interest.</p>
      <p><strong>Their email:</strong> {pc_email_used}</p>
      <p><strong>Reply snippet:</strong> {reply_snippet}</p>
      <p>Follow up promptly — this is a warm lead.</p>

B5. Post comment:
    "PRE-CHECK B: {reply_count} replies found.
     Demo interest: {demo_count} | Unsubscribe: {unsub_count} | OOO: {ooo_count} | Other: {other_count}
     {demo_count > 0 ? 'Warm leads notified to {review_email}.' : ''}"

    Add 3 new audit columns if not already present:
    pc_reply_received | pc_reply_intent | pc_reply_snippet

    MANDATORY: PRE-CHECKS are now complete. Proceed immediately to PHASE 0.
    Posting this comment is NOT task completion — the outreach pipeline has not started yet.
    PRE-CHECKs are audit-only maintenance steps. PHASE 0 through PHASE 8 MUST run next.
    → NEXT: PHASE 0 — Read config
```

---

## PHASE 0 — Read Config

```
0a. Read event_slug from the Paperclip issue description:
    → Scan issue description for a line starting with "event_slug:" or just the slug value on its own
    → If not found: post blocked comment "event_slug missing from issue description. Add it as: event_slug: asca-samba-2026", STOP

    Derive config path: "Marketing-Specialist/event-outreach/{event_slug}/config.md"

    sharepoint_read_file
    path="Marketing-Specialist/event-outreach/{event_slug}/config.md"
    → Parse all key: value pairs
    → If file missing: post blocked comment "config.md not found at Marketing-Specialist/event-outreach/{event_slug}/config.md. Create the folder and config, then retry.", STOP

0b. Validate required config keys present:
    event_name, event_slug, event_dates, event_location, booth_number,
    event_website, attendee_file, batch_size, min_send_pct, send_mode,
    outlook_user, review_email, email_subject, email_body_file

    → If any missing: post blocked comment listing exact missing keys, STOP

0c. Post issue comment:
    "Config loaded. Event: {event_name} | File: {attendee_file} | Batch: {batch_size} | Mode: {send_mode}"

    → NEXT: PHASE 1 — Load batch + column map

0d. Teams notification (non-blocking):
  teams_send_channel_message
    teamId    = $TEAMS_MARKETING_TEAM_ID
    channelId = $TEAMS_MARKETING_CHANNEL_ID
    contentType = "html"
    content:
      🟢 Event Outreach Started — {event_name}<br>
      <br>
      Event: {event_name} | {event_dates} | {event_location}<br>
      Attendee file: {attendee_file}<br>
      Batch size: {batch_size}<br>
      Send mode: {send_mode}<br>
      Issue: {PAPERCLIP_TASK_ID}
  If it fails → add "⚠️ Teams notification failed: {error_message}" to issue comment and continue.
```

---

## PHASE 1 — Load Batch

```
1a. sharepoint_get_file_info
    path="Marketing-Specialist/event-outreach/{event_slug}/{attendee_file}"
    → If not found: post blocked comment with exact path tried, STOP

1b. Read header row first to map column positions:
    sharepoint_excel_read_range
    → address: "A1:ZZ1"   ← header row only
    → identify column letters for: first_name, last_name, email, company, domain, title,
      prior_delivery_status, pc_status, pc_event, pc_email_used, pc_draft_id, and all audit columns

    Determine last data row — MUST re-read from first_name column NOW:
    WARNING: Do NOT reuse last_row from PRE-CHECKs. PRE-CHECK last_row was determined from
    pc_status column which is only populated for already-processed rows. That number is much
    smaller than the true attendee count. You MUST re-determine last_row here from first_name_col.

    sharepoint_excel_read_range
    → address: "{first_name_col}1:{first_name_col}2000"   ← first_name column, capped at 2000
    → count non-empty cells (excluding header) → last_row  ← THIS replaces any prior last_row value

    IMPORTANT — what to expect: The attendee file typically contains hundreds of rows.
    Most rows will have an EMPTY pc_status — those are the unprocessed attendees waiting to be emailed.
    A small number of rows near the top will have pc_status set (already processed in prior runs).
    Empty pc_status = NOT a problem. Empty pc_status = the rows you MUST process next.
    Do NOT stop because most rows have empty pc_status. That is expected and correct.

    Then read ONLY the columns needed for batch selection in narrow slices (never wide ranges):
    NEVER use comma-separated column addresses or unbounded ranges.

    Slice 1 — idempotency columns (3 cols max, row-bounded):
    sharepoint_excel_read_range
    → address: "{pc_status_col}1:{pc_event_col}{last_row}"
    → captures: pc_status, pc_event (adjacent columns assumed — reorder if not adjacent, see below)

    Slice 2 — prior delivery + email columns (3 cols max, row-bounded):
    sharepoint_excel_read_range
    → address: "{prior_delivery_status_col}1:{email_col}{last_row}"
    → captures: prior_delivery_status, email (adjacent columns assumed)

    Slice 3 — name + company columns (3 cols max, row-bounded):
    sharepoint_excel_read_range
    → address: "{first_name_col}1:{company_col}{last_row}"
    → captures: first_name, last_name, company (adjacent columns assumed)

    NOTE: If any two needed columns are non-adjacent, read each as a separate single-column range
    rather than a wide range that spans unneeded columns.

1c. Resolve column map — PARSE ONCE, CACHE FOREVER per event:

    CHECK if column-map.md already exists:
    sharepoint_get_file_info
    path="Marketing-Specialist/event-outreach/{event_slug}/column-map.md"

    IF exists → check if it contains `prior_delivery_status` mapping.
        If NOT present → delete and re-detect (column map is stale, missing new fields).

    IF exists AND contains all required fields → LOAD cached map:
        sharepoint_read_file
        path="Marketing-Specialist/event-outreach/{event_slug}/column-map.md"
        → Parse each line: canonical_field: header_name | column_index
        → Build column_map in memory
        → Log: "Column map loaded from cache."

    IF does not exist → PARSE headers now (first run only):
        → Read header row (row index 0) from Excel data already in memory
        → For each canonical field, scan all headers using inference rules from "Canonical field inference rules" table
        → Score each header: exact match = 3pts, starts-with = 2pts, contains = 1pt
        → Assign highest-scoring header to each canonical field
        → If required fields (first_name, last_name, company) have no match:
           post blocked comment:
           "Cannot infer required columns from Excel headers.
            Headers found: {comma-separated list of actual headers}
            Required: first_name, last_name, company.
            Either rename your Excel headers or manually create column-map.md at:
            Marketing-Specialist/event-outreach/{event_slug}/column-map.md"
           STOP

        → Write column-map.md to SharePoint:
        sharepoint_write_file
        path="Marketing-Specialist/event-outreach/{event_slug}/column-map.md"
        content:
        ---
        # Column Map — {event_slug}
        # Auto-generated {now ISO}. Edit manually only if Excel headers change.
        # Format: canonical_field: exact_header | column_index   (-1 = not found)
        # IMPORTANT: column_index is 0-BASED (A=0, B=1, C=2, ... Z=25, AA=26, AB=27, ...)

        first_name:             {matched_header}  | {index}
        last_name:              {matched_header}  | {index}
        email:                  {matched_header}  | {index or -1}
        company:                {matched_header}  | {index}
        domain:                 {matched_header}  | {index or -1}
        title:                  {matched_header}  | {index or -1}
        prior_delivery_status:  {matched_header}  | {index or -1}
        pc_status:              pc_status         | {index}
        pc_email_source:        pc_email_source   | {index}
        pc_email_used:          pc_email_used     | {index}
        pc_sent_at:             pc_sent_at        | {index}
        pc_event:               pc_event          | {index}
        pc_draft_id:            pc_draft_id       | {index}
        pc_delivery_status:     pc_delivery_status| {index or -1}
        pc_delivery_notes:      pc_delivery_notes | {index or -1}
        pc_reply_received:      pc_reply_received | {index or -1}
        pc_reply_intent:        pc_reply_intent   | {index or -1}
        pc_reply_snippet:       pc_reply_snippet  | {index or -1}
        ---

        → Post comment: "First run: column map inferred and cached at Marketing-Specialist/event-outreach/{event_slug}/column-map.md. Review it if any mapping looks wrong."
        → Log each mapping: "first_name → '{header}' (col {index})"

1d. SANITY CHECK pc_status column before proceeding:
    After reading the pc_status slice (Step 3 of 1b):
    → Count rows with any non-empty pc_status value → known_processed_count
    → Count rows with pc_email_used non-empty (read {pc_email_used_col}1:{pc_email_used_col}{last_row}) → email_written_count

    IF known_processed_count = 0 AND email_written_count > 0:
    → The pc_status column letter is WRONG — agent read the wrong column, saw all-empty, but emails
      have been sent (pc_email_used has data). This is a column mapping error.
    → Post BLOCKED comment:
      "HALT: pc_status column appears empty but pc_email_used has {email_written_count} values.
       Column mapping is likely wrong. Check column-map.md and verify pc_status column letter.
       Do NOT proceed — risk of re-sending to already-processed rows."
    → STOP

1e. Find next {batch_size} eligible rows:

    CORE PRINCIPLE: Rows with EMPTY pc_status are the target. The whole point of this phase
    is to find those rows and process them. A large number of empty pc_status rows is normal —
    it means there are many attendees still waiting to be contacted. Pick the first {batch_size}
    of them and proceed. Do NOT interpret many empty rows as an error or as "nothing to do."

    PRIMARY rule — a row is SKIPPED if pc_status is non-empty (any value):
    → pc_status = "sent"           → SKIP (emailed this event)
    → pc_status = "draft_created"  → SKIP (drafted, awaiting approval)
    → pc_status = "skipped"        → SKIP (intentionally skipped)
    → pc_status = "email_not_found"→ SKIP (no email found, cannot send)
    → pc_status = "error"          → SKIP (failed — do not retry automatically)
    → pc_status = "pending"        → eligible (was staged but not yet sent)

    SECONDARY rule — also skip if:
    → prior_delivery_status = "sent"  (sent by prior system — NEVER re-send, write NOTHING to pc_* columns)

    A row IS eligible if AND ONLY if:
    → pc_status is EMPTY/MISSING (not set to any value above)  ← this is the common case
    → AND prior_delivery_status != "sent"

    NOTE: pc_event alone is NOT a skip condition. A row where pc_event is set but pc_status
    is empty was partially written (Hunter ran but send failed) — treat it as eligible and
    re-attempt. The pc_event value will be overwritten on re-process.

    IMPORTANT: When skipping a row due to prior_delivery_status = "sent", write NOTHING to any pc_* column.
    Do not overwrite, do not set pc_status = "sent". Leave it completely untouched.

    → If zero eligible rows:
       post comment "All attendees processed for {event_name}. Nothing to do."
       update issue → done, STOP

1e. Split batch into two groups:
    has_email  = rows where Email column is non-empty
    need_email = rows where Email column is empty

    Post comment:
    "Batch loaded: {batch_size} rows | Has email: {count} | Missing email: {count}"

    → NEXT: PHASE 2 — Hunter email enrichment (skip phase if need_email is empty, go straight to PHASE 3)
```

---

## PHASE 2 — Hunter Email Enrichment (missing_email rows only)

Skip this phase entirely if `need_email` list is empty.

```
2a. Check credit budget BEFORE processing any row:
    hunter_account_info
    → store: search_credits_remaining, verify_credits_remaining
    → unprocessed_remaining = total eligible rows not yet sent across all batches
    → safe_fallback_budget  = search_credits_remaining - unprocessed_remaining - 20
      (20 = safety buffer)
    → if safe_fallback_budget > 0: fallback_allowed = true
    → else: fallback_allowed = false
    → Post comment: "Hunter budget check: {search_credits_remaining} search / {verify_credits_remaining} verify credits remaining. Fallback domain search: {fallback_allowed}."

2b. For each row in need_email:

    STEP 1 — Resolve domain (free, no credits):
    → If col_domain exists and cell non-empty → use it directly, skip DuckDuckGo
    → Else: duckduckgo_search query='"{company}" official website'
      → extract domain from first result URL (strip www., keep base domain)
      → If no domain found → mark pc_status="email_not_found", pc_notes="domain not found", continue to next row

    STEP 2 — Primary: hunter_find_email (name + domain):
    hunter_find_email
    → first_name: {first_name}
    → last_name:  {last_name}
    → domain:     {resolved_domain}
    → uses 1 search credit

    On success (email returned):
    → store: hunter_email = email, hunter_confidence = score
    → pc_hunter_method = "email_finder"
    → email_resolved = true
    → SKIP Step 3 — do not use fallback
    → proceed directly to STEP 4 (verify)

    On no result:
    → proceed to STEP 3 (fallback)

    STEP 3 — Fallback: hunter_search_domain (only if Step 2 found nothing):
    IF fallback_allowed = false:
    → mark pc_status="email_not_found", pc_notes="credit budget exhausted, fallback skipped"
    → continue to next row

    IF fallback_allowed = true:
    hunter_search_domain
    → domain: {resolved_domain}
    → limit: 10
    → uses 1 search credit
    → decrement safe_fallback_budget by 1
    → if safe_fallback_budget <= 0: set fallback_allowed = false for remaining rows

    → Scan returned emails, score each by name match:
      score = 0
      if first_name appears in result name → score += 2
      if last_name appears in result name  → score += 3
      select highest scoring result (minimum score 2 to accept)

    On match found (score ≥ 2):
    → store: hunter_email = matched email, hunter_confidence = result confidence
    → pc_hunter_method = "domain_search"
    → email_resolved = true
    → proceed to STEP 4 (verify)

    On no match:
    → mark pc_status="email_not_found", pc_email_source="none"
    → continue to next row

    STEP 4 — Verify email (always, for every Hunter-found email):
    hunter_verify_email
    → email: {hunter_email}
    → uses 1 verify credit

    Result handling:
    → "deliverable"   → pc_email_risk="deliverable", email_resolved=true, proceed to send
    → "risky"         → pc_email_risk="risky",        email_resolved=true, proceed to send + audit
    → "undeliverable" → pc_email_risk="undeliverable", email_resolved=false,
                         pc_status="email_not_found", pc_notes="undeliverable per Hunter verify"
    → error/timeout   → pc_email_risk="unknown", treat as risky (send + audit)

2c. After all rows processed, merge results into has_email group:
    → email_resolved = true  → add to sendable list
    → email_resolved = false → stays out of send list

2d. Post comment:
    "Hunter enrichment complete.
     Found (email_finder): {ef_count} | Found (domain_search): {ds_count}
     Deliverable: {del_count} | Risky: {risky_count} | Undeliverable: {undel_count} | Not found: {nf_count}
     Search credits remaining: ~{search_credits_remaining - credits_used}"

    → NEXT: PHASE 3 — Sufficiency check
```

**2z. Teams notification (non-blocking) — only if any Hunter lookups were attempted:**
  teams_send_channel_message
    teamId    = $TEAMS_MARKETING_TEAM_ID
    channelId = $TEAMS_MARKETING_CHANNEL_ID
    contentType = "html"
    content:
      🔍 Email Enrichment Complete — {event_name}<br>
      <br>
      Found (email_finder): {ef_count} | Found (domain_search): {ds_count}<br>
      Not found: {nf_count} attendees<br>
      Deliverable: {del_count} | Risky: {risky_count} | Undeliverable: {undel_count}<br>
      <br>
      Proceeding to sufficiency check.
  If it fails → add "⚠️ Teams notification failed: {error_message}" to issue comment and continue.

---

## PHASE 3 — Sufficiency Check

```
3a. sendable_count = len(has_email)  ← original emails + hunter-found
    total_batch    = batch_size (or actual eligible rows if less)
    send_pct       = (sendable_count / total_batch) * 100

3b. IF send_pct >= min_send_pct:
    → Proceed to Phase 4 — send
    → Post comment: "Sufficiency check passed: {send_pct:.0f}% have email ({sendable_count}/{total_batch}). Proceeding."

3c. IF send_pct < min_send_pct:
    → Post comment:
      "Sufficiency check failed: only {send_pct:.0f}% have email ({sendable_count}/{total_batch}).
       Threshold is {min_send_pct}%. Sending what we have and marking rest as email_not_found."
    → Proceed anyway — send to all rows that DO have an email, skip the rest
    → (Do not block entirely — partial send is better than no send)

    → NEXT: PHASE 4 — Compose and send / draft emails

3c-notify. Teams notification (non-blocking):
  teams_send_channel_message
    teamId    = $TEAMS_MARKETING_TEAM_ID
    channelId = $TEAMS_MARKETING_CHANNEL_ID
    contentType = "html"
    content:
      ⚠️ Below Email Threshold — {event_name}<br>
      <br>
      Found: {sendable_count}/{total_batch} emails ({send_pct}%)<br>
      Threshold: {min_send_pct}%<br>
      Action: Sending to {sendable_count} attendees — rest marked email_not_found<br>
      <br>
      Partial send proceeding.
  If it fails → add "⚠️ Teams notification failed: {error_message}" to issue comment and continue.
```

---

## PHASE 4 — Compose and Send / Draft Emails

```
4a. For each row in sendable (has_email) list:

    Resolve send address:
    → If pc_email_source = "hunter": use hunter_email
    → Else: use original Email column value

    Compose subject:
    → Replace {event_name}, {first_name}, {booth_number}, {event_dates}, {event_location}
      in email_subject from config

    Compose HTML body:
    → sharepoint_read_file path="Marketing-Specialist/event-outreach/{event_slug}/{email_body_file}"
    → Replace all placeholders in template: {first_name}, {event_name}, {event_dates},
      {event_location}, {booth_number}, {event_website}, {company}, {title}
    → Append standard Medicodio signature block (below)

    Standard signature (always appended — never in config):
    ---
    <table cellpadding="0" cellspacing="0" border="0"
      style="font-family:Arial,Helvetica,sans-serif;color:#333;line-height:1.5;border-left:3px solid #0a1d56;padding-left:16px;">
      <tr><td>
        <table cellpadding="0" cellspacing="0" border="0">
          <tr><td style="font-size:14px;color:#0a1d56;font-weight:700;padding-bottom:2px;">Thanks &amp; Regards,</td></tr>
          <tr><td style="font-size:16px;color:#0a1d56;font-weight:700;padding-bottom:4px;">Medicodio</td></tr>
          <tr><td style="font-size:12px;color:#666;padding-bottom:10px;letter-spacing:0.3px;text-transform:uppercase;">AI Powered Medical Coding</td></tr>
          <tr><td style="font-size:13px;color:#333;padding-top:8px;border-top:1px solid #e5e7eb;">
            <a href="https://medicodio.ai/" style="color:#0a1d56;text-decoration:none;font-weight:600;">MediCodio AI</a>
            <span style="color:#c0c5d1;padding:0 6px;">|</span>
            <a href="https://www.linkedin.com/company/medicodioai/" style="color:#0a1d56;text-decoration:none;font-weight:600;">LinkedIn</a>
            <span style="color:#c0c5d1;padding:0 6px;">|</span>
            <a href="mailto:{outlook_user}" style="color:#0a1d56;text-decoration:none;font-weight:600;">{outlook_user}</a>
          </td></tr>
        </table>
      </td></tr>
    </table>

4b. IF send_mode = "direct":
    resend_send_email  (uses RESEND_API_KEY from env — no daily send limit)
    → from: {outlook_user}
    → to: {resolved_email}
    → subject: {composed_subject}
    → html: {composed_html}
    → on success: mark pc_status = "sent", pc_draft_created_at = blank, pc_sent_at = now ISO
    → on error: mark pc_status = "error", pc_notes = "{error}", continue

4c. IF send_mode = "draft_review":
    outlook_create_draft
    → mailbox: {outlook_user}
    → to: {resolved_email}
    → subject: {composed_subject}
    → body: {composed_html}
    → bodyType: "HTML"
    → save returned draft message ID
    → mark pc_status = "draft_created", pc_draft_id = "{draftId}", pc_draft_created_at = now ISO, pc_sent_at = blank

4d. Post progress comment every 10 rows:
    "Progress: {sent}/{sendable_count} emails {send_mode == direct ? "sent" : "drafted"}."

    → NEXT: PHASE 5 — Write audit columns back to Excel
```

**4z. Teams notification (non-blocking):**
  teams_send_channel_message
    teamId    = $TEAMS_MARKETING_TEAM_ID
    channelId = $TEAMS_MARKETING_CHANNEL_ID
    contentType = "html"
    content:
      📧 Event Outreach Batch — {event_name}<br>
      <br>
      Sent: {sent_count} emails<br>
      Drafted: {drafted_count} (pending review)<br>
      Skipped: {not_found_count} (no email found)<br>
      Errors: {error_count}<br>
      <br>
      Writing audit columns to Excel now.
  If it fails → add "⚠️ Teams notification failed: {error_message}" to issue comment and continue.

---

## PHASE 5 — Write Audit Columns Back to Excel

```
5a. For every row in this batch (sendable + email_not_found + error):

    sharepoint_excel_write_range
    filePath="Marketing-Specialist/event-outreach/{event_slug}/{attendee_file}"
    sheetName="{attendee_sheet}"
    → Write per-row values:
       pc_status              = {status}
       pc_email_source        = {original | hunter | none}
       pc_email_used          = {email address used, or blank if not_found}
       pc_draft_created_at    = {ISO timestamp when draft created, or blank}
       pc_sent_at             = {ISO timestamp when actually sent, or blank}
       pc_event               = {event_slug}
       pc_draft_id            = {draft_id or blank}
       pc_hunter_confidence   = {score or blank}
       pc_notes               = {error/skip reason or blank}

5b. Verify write:
    sharepoint_excel_read_range → spot-check 3 random rows
    → Confirm pc_status values persisted
    → Log: "Excel audit write verified."

    → NEXT: PHASE 6 — Notify reviewer (skip to PHASE 8 if send_mode = direct)
```

---

## PHASE 6 — Notify Reviewer (draft_review mode only)

Skip if `send_mode = "direct"`.

```
6a. Compose summary table:
    | First Name | Last Name | Company | Draft ID |
    ...one row per draft created

6b. resend_send_email  (uses RESEND_API_KEY — no daily limit)
    → from: {outlook_user}
    → to: {review_email}
    → subject: "[{event_name}] {N} outreach drafts ready for review — {today date}"
    → body:
      <p>Hi,</p>
      <p>{N} outreach emails drafted for <strong>{event_name}</strong> attendees and saved to Outlook Drafts.</p>
      {summary_table}
      <p>To send: go to Paperclip issue #{issueId} and click Approve.<br>
         To skip: reject with a note.</p>
      <p>— Marketing Specialist</p>

6c. Create Paperclip approval on current issue:
    → title: "Review and approve {N} outreach drafts for {event_name}"
    → body: summary table + draft IDs
    → required approver: {review_email} user

6d. Post comment:
    "{N} drafts created. Approval requested. Awaiting review before sending."

    → NEXT: PHASE 7 — Await approval / rejection (issue stays open until decision received)
```

---

## PHASE 7 — On Approval (draft_review mode only)

```
7a. Agent receives approval notification

7b. Read draft IDs from approval body

7c. For each row in this batch (read pc_email_used + composed body from memory or re-read draft):
    resend_send_email  (uses RESEND_API_KEY — no daily limit)
    → from: {outlook_user}
    → to: {pc_email_used}
    → subject: {composed_subject}
    → html: {composed_html}
    → on success: note sent
    → on error: note failure, continue others

    Note: Outlook drafts created in Phase 4 are for preview only.
    Resend is the actual delivery mechanism on approval.
    Delete or ignore the Outlook draft after send.

7d. sharepoint_excel_write_range
    → For each sent row: pc_status = "sent", pc_sent_at = now ISO  (pc_draft_created_at unchanged)
    → For any failed: pc_status = "send_failed", pc_notes = "{error}"

7e. Post final comment:
    "All {N} emails sent for {event_name}. Excel updated."

7f. Update issue → done

    → NEXT: PHASE 8 — Run log and summary
```

## On Rejection (draft_review mode only)

```
7g. Read rejection reason
7h. sharepoint_excel_write_range → pc_status = "skipped", pc_notes = "{rejection reason}"
7i. Post comment: "Approval rejected. Rows marked skipped. Reason: {reason}"
7j. Update issue → done
```

---

## PHASE 8 — Run Log and Summary

```
8a. sharepoint_write_file
    path="Marketing-Specialist/event-outreach/{event_slug}/run-logs/{YYYY-MM-DD}.md"
    content:
    ---
    # Event Outreach Run — {event_name}
    **Date:** {YYYY-MM-DD HH:MM UTC}
    **Issue:** #{issueId}

    ## Config Used
    | Key | Value |
    |-----|-------|
    | event_name | {event_name} |
    | attendee_file | {attendee_file} |
    | batch_size | {batch_size} |
    | send_mode | {send_mode} |
    | min_send_pct | {min_send_pct}% |

    ## Results
    | Metric | Count |
    |--------|-------|
    | Batch size | {batch_size} |
    | Had email (original) | {original_count} |
    | Hunter found | {hunter_found} |
    | Hunter not found | {hunter_not_found} |
    | Sent / Drafted | {sent_count} |
    | Skipped (email_not_found) | {not_found_count} |
    | Errors | {error_count} |
    | Send % | {send_pct:.0f}% |

    ## Rows Not Emailed
    {table: name + company + reason}

    ## Errors
    {list of row + error detail, if any}
    ---

8b. Post final issue comment:
    "Run complete for {event_name}.
     Sent/Drafted: {sent_count} | Not found: {not_found_count} | Errors: {error_count}
     Run log: Marketing-Specialist/event-outreach/{event_slug}/run-logs/{YYYY-MM-DD}.md"

8b-notify. Teams notification (non-blocking):
  teams_send_channel_message
    teamId    = $TEAMS_MARKETING_TEAM_ID
    channelId = $TEAMS_MARKETING_CHANNEL_ID
    contentType = "html"
    content:
      ✅ Event Outreach Complete — {event_name}<br>
      <br>
      Sent: {sent_count} | Drafted: {drafted_count}<br>
      Enriched: {hunter_found} | Skipped: {not_found_count}<br>
      Errors: {error_count}<br>
      Run log: Marketing-Specialist/event-outreach/{event_slug}/run-logs/{YYYY-MM-DD}.md<br>
      Issue: {PAPERCLIP_TASK_ID}
  If it fails → add "⚠️ Teams notification failed: {error_message}" to issue comment and continue.

8c. Update issue → done (direct mode) or leave open awaiting approval (draft_review mode)

    ✓ PIPELINE COMPLETE.
```

---

## Error Handling Reference

| Situation | Action |
|-----------|--------|
| `config.md` missing | Block issue with exact path, STOP |
| Required config key missing | Block issue listing missing keys, STOP |
| `HUNTER_API_KEY` not set | Block issue, STOP |
| Attendee file not found | Block issue with exact path tried, STOP |
| Required Excel columns missing | Block issue with headers found, STOP |
| Zero eligible rows | Comment "all done", close issue |
| Hunter rate limit (429) | Wait 2s, retry once; mark error if still fails |
| Hunter not found | Mark `email_not_found`, continue batch |
| Email send fails | Mark `error` + notes, continue other rows |
| Excel write fails | Retry once after 3s; block issue if both fail |
| All rows already processed | Comment "nothing to do", close issue |

**Teams failure notification (non-blocking) — send when any situation above causes a STOP or blocked status:**
  teams_send_channel_message
    teamId    = $TEAMS_MARKETING_TEAM_ID
    channelId = $TEAMS_MARKETING_CHANNEL_ID
    contentType = "html"
    content:
      🔴 Event Outreach — Technical Failure<br>
      <br>
      Event: {event_name}<br>
      Error: {error_message}<br>
      Phase: {current PHASE name, e.g. "PHASE 2 — Email Enrichment"}<br>
      Issue: {PAPERCLIP_TASK_ID}<br>
      <br>
      Routine stopped or blocked. Check issue for details.
  If it fails → add "⚠️ Teams notification failed: {error_message}" to issue comment and continue.

---

## How to Run for a New Event

1. Upload `{event}.xlsx` to SharePoint at `Marketing-Specialist/event-outreach/`
2. Edit `Marketing-Specialist/event-outreach/config.md` (update event fields + filename)
3. Create a Paperclip issue assigned to `marketing-specialist`
4. Done — routine reads fresh config, processes attendees, no code change

---

## Reuse Guarantee

- The `.md` routine file: **never edit between events**
- The attendee Excel: **upload new file per event**
- The config: **update 6–8 fields per event**
- Hunter API key: **set once in env, reused forever**
