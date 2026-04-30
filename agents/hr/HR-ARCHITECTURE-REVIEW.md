# HR Onboarding Agent — Architecture Review Document

> **Purpose:** Full end-to-end reference of the HR agent system. Read this to understand every component, flow, tool, and decision point.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Files & Components](#2-files--components)
3. [Tools & MCPs](#3-tools--mcps)
4. [How a Case Starts — Trigger Flow](#4-how-a-case-starts--trigger-flow)
5. [Employee Types & Document Checklists](#5-employee-types--document-checklists)
6. [Status Model — All States](#6-status-model--all-states)
7. [Status Transition Rules](#7-status-transition-rules)
8. [Routine: employee-onboarding — Phase by Phase](#8-routine-employee-onboarding--phase-by-phase)
9. [Routine: email-heartbeat — 30-min Polling Loop](#9-routine-email-heartbeat--30-min-polling-loop)
10. [Skill: document-validator](#10-skill-document-validator)
11. [SharePoint Storage Layout](#11-sharepoint-storage-layout)
12. [Audit Log](#12-audit-log)
13. [Human-in-the-Loop Touchpoints](#13-human-in-the-loop-touchpoints)
14. [Failure Handling Summary](#14-failure-handling-summary)
15. [Security & Data Sensitivity Rules](#15-security--data-sensitivity-rules)
16. [Full Flow Diagram (text)](#16-full-flow-diagram-text)
17. [Open Questions & Gaps](#17-open-questions--gaps)

---

## 1. System Overview

The HR agent is a **fully automated onboarding coordinator**. When Karthik (or any HR person) creates a Paperclip issue with employee details, the agent:

1. Routes the trigger: if it's a fresh case, runs full setup; if it's a heartbeat resume, jumps directly to reply processing
2. Creates a SharePoint folder for the employee
3. Sends the correct document request email based on employee type
4. Polls every 30 minutes for replies (via the heartbeat routine)
5. Sends reminder nudges at 24h and 48h if no reply
6. Stalls the case at 72h and alerts HR
7. When the candidate replies, validates all documents automatically
8. Flags missing or incorrect documents with specific resubmission requests
9. Notifies HR for human verification once all docs are in order
10. Uploads verified documents to SharePoint on human approval
11. Closes the case

**No human action is needed** until step 9 (document verification approval). Everything before that is fully automated.

**Global conventions applied throughout:**
- All timestamps: ISO-8601 UTC format — `YYYY-MM-DDTHH:MM:SSZ` (e.g. `2026-04-23T09:15:00Z`)
- All emails: `isHtml: true` — never plain text
- Audit-log: all 11 columns mandatory on every row — no exceptions
- Government ID masking: Aadhaar / PAN digits never logged, emailed, or output — placeholders only

**Escalation rule:** At ANY layer of ambiguity — unexpected reply, unclear document, missing data, unrecognized sender, anything outside the normal flow — the agent STOPS all automated actions and notifies `human_in_loop_email` with full context: what happened, what was received, what was attempted, and exactly what human action is needed.

---

## 2. Files & Components

```
agents/hr/
├── AGENTS.md                          ← Agent identity, SharePoint config, critical rules
├── mcp.json                           ← MCP servers available to this agent
├── HR-ENV-VARS.md                     ← All env vars, Azure permissions, setup checklist
├── HR-SHAREPOINT-CONFIG-TEMPLATE.md  ← Template for HR-Onboarding/config.md in SharePoint
├── routines/
│   ├── employee-onboarding.md         ← Main onboarding workflow (Phase 0–10, Steps 1–59)
│   └── email-heartbeat.md             ← 30-min cron: polls email, sends nudges
└── skills/
    └── document-validator.md          ← Reads attachments, validates against checklist
```

| File | Type | Trigger | Purpose |
|------|------|---------|---------|
| `AGENTS.md` | Agent config | — | Agent identity, SharePoint path, critical rules |
| `employee-onboarding.md` | Routine | API-triggered (issue or heartbeat resume) | Full onboarding — Phase 0–10, Steps 1–59 |
| `email-heartbeat.md` | Routine | Cron every 30 min | Email polling, nudges, stall detection |
| `document-validator.md` | Skill | Called by onboarding routine | Reads email + attachments, validates docs |

**Supported document formats** (handled by `document-validator` skill):

| Format | Support | How |
|--------|---------|-----|
| PDF | ✅ | Full text extraction |
| DOCX | ✅ | Full text extraction |
| JPG / JPEG / PNG / GIF / WEBP | ✅ | Claude vision reads image directly |
| TXT / CSV / MD | ✅ | Raw text |
| HEIC / TIFF | ⚠️ Uncertain | Flagged for manual review |
| ZIP / RAR | ❌ | Candidate asked to send files unzipped |
| Other binary | ❌ | Metadata only, flagged for manual review |

---

## 3. Tools & MCPs

The HR agent has access to these MCP servers (defined in `mcp.json`):

### `outlook` MCP — Email operations

**Credentials:** Uses `OUTLOOK_TENANT_ID`, `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_MAILBOX`. These are scoped separately from SharePoint — the Outlook MCP never receives SharePoint credentials. Both currently point to the same Azure app registration; set separate `OUTLOOK_CLIENT_ID` / `OUTLOOK_CLIENT_SECRET` values in `.env` when a dedicated Mail-only app is registered.

| Tool | Used in | What it does |
|------|---------|-------------|
| `outlook_send_email` | Onboarding Phases 2, 6, 8; Heartbeat | Send initial doc request, reminders, HR alerts, resubmission requests |
| `outlook_search_emails` | Heartbeat Steps 3a, 3b | Search for candidate replies |
| `outlook_read_email` | Document-validator Step 1a | Read full email body + metadata |
| `outlook_list_attachments` | Document-validator Step 1b | List all attachments on an email |
| `outlook_read_attachment` | Document-validator Step 2 | Extract text from PDF/DOCX, read images via Claude vision |
| `outlook_reply` | Document-validator Step 5 | Reply to candidate email with validation results |

**All emails must use `isHtml: true`.** Plain text loses Outlook formatting.

---

### `sharepoint` MCP — Document storage

**Credentials:** Uses `SHAREPOINT_TENANT_ID`, `SHAREPOINT_CLIENT_ID`, `SHAREPOINT_CLIENT_SECRET`, `SHAREPOINT_SITE_URL`. Scoped to SharePoint only — not injected into Outlook MCP.

**SharePoint error handling:** On HTTP 429 (rate limited) or 503 (service unavailable): wait 10s and retry up to 3 times. On 3rd failure: status = escalated, notify `human_in_loop_email` with the failed operation, path, and error. Never silently drop data.

| Tool | Used in | What it does |
|------|---------|-------------|
| `sharepoint_list_folder` | Onboarding (idempotency check) | Check if employee folder already exists |
| `sharepoint_create_folder` | Onboarding Phase 1 Steps 6–9 | Create employee folder + 3 subfolders |
| `sharepoint_read_file` | Heartbeat Step 1; Agent config | Read audit-log for active cases; read config.md |
| `sharepoint_write_file` | Onboarding throughout | Create case-tracker, upload docs, append audit-log |

**SharePoint site:** `https://medicodio.sharepoint.com/sites/MedicodioMarketing`  
**Base path:** `HR-Onboarding/`

---

### Other MCPs (available but not core to onboarding)

| MCP | Purpose |
|-----|---------|
| `duckduckgo` | Web search (not used in onboarding flow) |
| `fetch` | HTTP fetch (not used in onboarding flow) |
| `playwright` | Browser automation (not used in onboarding flow) |
| `apify` | Actor runners — requires mandatory follow-up with `get-actor-output` after every call |

---

## 4. How a Case Starts — Trigger Flow

```
Karthik creates a Paperclip issue
         │
         ├── Label: "onboarding"
         ├── Title starts with "Onboard:"
         └── Body contains "employee_type:" field
                    │
                    ▼
         HR agent heartbeat detects issue
                    │
                    ▼
         Extracts employee fields from issue body
                    │
                    ▼
         POST /api/routines/ddedecdb-871a-4ad1-980b-5935a2ecda75/run
         {
           "source": "manual",
           "payload": { employee fields },
           "idempotencyKey": "{employee_email}-{date_of_joining}"
         }
                    │
                    ▼
         employee-onboarding routine → PHASE 0 (source gate) → PHASE 1
```

### Required issue body fields

```
employee_full_name: Jane Doe
employee_email: jane.doe@example.com
role: Software Engineer
employee_type: fresher          ← intern | fresher | fte | experienced | contractor | rehire
date_of_joining: 2026-05-01
recruiter_or_hr_name: Karthik
recruiter_or_hr_email: karthik.r@medicodio.ai
human_in_loop_name: Karthik
human_in_loop_email: karthik.r@medicodio.ai
```

### Optional fields
`alternate_candidate_email`, `date_of_birth` (ISO format — used for identity verification in Phase 5), `hiring_manager_name`, `hiring_manager_email`, `business_unit`, `location`, `joining_mode`, `notes_from_hr`, `special_document_requirements`

**Idempotency:** Case ID = `{employee_email}-{date_of_joining}`. If an active case already exists for this key, the routine continues it rather than creating a duplicate. If a *completed* case exists with the same key (same-date rehire), the key is suffixed with `-rehire-{N}` and HR is notified.

---

## 5. Employee Types & Document Checklists

### Intern / Fresher

| # | Document | Mandatory |
|---|----------|-----------|
| 1 | Latest Resume | ✓ |
| 2 | Passport Size Photo (soft copy) | ✓ |
| 3 | Education Certificates: SSLC to Highest | ✓ |
| 4 | PAN Card (scan copy) | ✓ |
| 5 | Passport Scan Copy | If applicable |
| 6 | Permanent & Temporary Address (detailed) | ✓ |
| 7 | Address Proof (Aadhaar / DL / Voter ID) — Aadhaar mandatory | ✓ |
| — | Full Name, Email ID, DOB (in email body) | ✓ |

---

### FTE / Experienced

| # | Document | Mandatory |
|---|----------|-----------|
| 1 | Highest Qualification Certificate | ✓ |
| 2 | All Offer Letters / Appointment Letters | ✓ |
| 3 | Last 3 Months Payslips | ✓ |
| 4 | All Relieving Letters | ✓ |
| 5 | Aadhaar Card | ✓ (mandatory) |
| 6 | PAN Card | ✓ |
| 7 | Address Proof (Rental Agreement / Electricity / Gas / Phone bill) | ✓ |
| — | Full Name, Email ID, DOB (in email body) | ✓ |

---

### Contractor

| # | Document | Mandatory |
|---|----------|-----------|
| 1 | Latest Resume | ✓ |
| 2 | PAN Card | ✓ |
| 3 | Aadhaar Card | ✓ |
| 4 | Address Proof | ✓ |
| — | Full Name, Email ID, DOB | ✓ |
| — | Additional requirements (if `special_document_requirements` is set) | If specified |

**Note:** The `{special_document_requirements}` placeholder is only included in the email if the field is non-empty. If empty, the line is omitted entirely — the placeholder text is never sent to the candidate verbatim.

---

### Rehire

| # | Document | Notes |
|---|----------|-------|
| 1 | Updated Resume | ✓ |
| 2 | Updated Address | ✓ |
| 3 | Address Proof | ✓ |
| 4 | PAN / Aadhaar (if changed) | Only if updated |
| — | Full Name, Email ID, DOB | ✓ |

**Note:** Rehire cases require human confirmation first — HR must confirm whether prior documents can be reused before any document request is sent. If a completed case already exists for the same email + joining date, an `-rehire-{N}` suffix is added to the case ID and HR is alerted.

---

## 6. Status Model — All States

### Happy path (in order)

```
initiated
    → initial_email_sent
        → awaiting_document_submission
            → candidate_acknowledged         (reply = "will send soon" — not a submission)
            → partial_submission_received    (some docs received, waiting for rest)
            → complete_submission_received
                → under_automated_review
                    → discrepancy_found      (if issues found)
                        → awaiting_resubmission
                            ↑ loops back via heartbeat → Phase 4 → Phase 5 → Phase 7
                    → awaiting_human_verification
                        → verified_by_human
                            → sharepoint_upload_in_progress
                                → uploaded_to_sharepoint
                                    → completed
```

### Exception statuses

| Status | Meaning | How to recover |
|--------|---------|----------------|
| `stalled` | No reply after 2 nudges (72h+) | Human must manually follow up; resume from last stalled step using audit-log context |
| `escalated` | System error, upload failure, or ambiguous case | Human must investigate and re-trigger if needed |
| `withdrawn` | Candidate withdrew / postponed | Human notified by email — manual decision required |
| `cancelled` | HR or candidate cancelled | Case closed, human notified |

**Per-employee tracking:** Each employee has a `case-tracker.md` file in their SharePoint folder at:
```
HR-Onboarding/{employee_full_name} - {date_of_joining}/case-tracker.md
```
Contains: Status History (every status change with timestamp), Document Tracker (each doc: pending/received/verified/rejected/uploaded), Identity Verification results, Reminders Sent log. Updated automatically at every phase. The case-tracker is owned exclusively by the onboarding routine — the heartbeat never writes to it.

---

## 7. Status Transition Rules

Every audit-log row MUST use the `current_status` value from this table for the given event. Use exactly the value listed — never guess.

| Event | `current_status` to write |
|-------|--------------------------|
| `case_created` | `initiated` |
| `initial_email_sent` | `initial_email_sent` |
| `awaiting_reply` | `awaiting_document_submission` |
| `candidate_acknowledged` | `candidate_acknowledged` |
| `reminder_1_sent` | `awaiting_document_submission` |
| `reminder_2_sent` | `awaiting_document_submission` |
| `reply_detected` | `awaiting_document_submission` |
| `reply_from_alternate_sender` | `awaiting_document_submission` |
| `partial_submission_received` | `partial_submission_received` |
| `complete_submission_received` | `complete_submission_received` |
| `under_automated_review` | `under_automated_review` |
| `discrepancy_found` | `discrepancy_found` |
| `resubmission_requested` | `awaiting_resubmission` |
| `human_notified` | *(no change — keep current status)* |
| `human_approved` | `verified_by_human` |
| `sharepoint_folder_created` | `initiated` |
| `files_uploaded` | `uploaded_to_sharepoint` |
| `case_completed` | `completed` |
| `case_stalled` | `stalled` |
| `case_cancelled` | `cancelled` |
| `case_withdrawn` | `withdrawn` |
| `escalated` | `escalated` |
| `heartbeat_tick` | *(no change — keep current status)* |

---

## 8. Routine: employee-onboarding — Phase by Phase

**Routine ID:** `ddedecdb-871a-4ad1-980b-5935a2ecda75`  
**Trigger:** API call (from issue detection or heartbeat reply delegation)  
**Concurrency:** `always_enqueue` — each employee is an independent run  
**Steps:** 1–59 (sequential across all phases, no resets between phases)

---

### PHASE 0 — Source routing gate *(new)*

**Step 1**

The very first thing the routine does on every trigger — before any other work.

| `source` value | Action |
|---------------|--------|
| `"heartbeat_reply_detected"` | Skip Phase 1, 2, 3 entirely. Jump directly to Phase 4. Extract `case_id`, `messageId`, `employee_email`, `employee_full_name`, `current_status` from payload. |
| `"manual"` or `"issue_trigger"` or absent | Proceed normally from Phase 1. |

This prevents the routine from re-creating folders, re-sending emails, or re-logging `case_created` when it is resumed by the heartbeat to process a reply.

**Tools used:** None (payload inspection only)

---

### PHASE 1 — Validate inputs & create SharePoint folders

**Steps 2–11**

1. Parse all required fields (Step 2)
2. Validate `employee_type` — if unknown: notify HR, status = escalated, STOP (Step 3)
3. If rehire → notify HR, await decision before full doc request (Step 4)
4. Set status = `initiated` (Step 5)
5. Create SharePoint folders (Steps 6–9):
   - `HR-Onboarding/{name} - {date}/`
   - `01_Raw_Submissions/`
   - `02_Verified_Documents/`
   - `03_Exception_Notes/`
   - On failure (after 3 retries): status = escalated, notify HR, STOP
6. Append `case_created` row to audit-log with all 11 columns (Step 10)
7. Create per-employee `case-tracker.md` in SharePoint (Step 11)

**Tools used:** `sharepoint_create_folder`, `sharepoint_write_file`, `outlook_send_email` (for escalation)

---

### PHASE 2 — Send initial document request email

**Steps 12–17**

- Selects HTML email template based on `employee_type` (intern/fresher, FTE/experienced, contractor, rehire)
- Contractor template: `special_document_requirements` line is only included if the field is non-empty — never outputs the placeholder verbatim
- Sends via `outlook_send_email` with `isHtml: true`
- Records `initial_email_sent_timestamp`, updates issue comment, appends to audit-log
- Updates case-tracker Status History
- If send fails: notify HR immediately, status = escalated, STOP

**Tools used:** `outlook_send_email`, `sharepoint_write_file` (case-tracker update)

**Email subjects:**
- All types: `"Documents Required for Onboarding – {name}"`

---

### PHASE 3 — Wait for candidate reply (heartbeat owns polling)

**Steps 18–21**

- Sets status = `awaiting_document_submission`
- Appends `awaiting_reply` row to audit-log
- Posts issue comment with nudge cadence info
- **Does NOT poll emails itself** — the `email-heartbeat` routine handles all polling
- Resumes when heartbeat calls this routine with `source: "heartbeat_reply_detected"` → Phase 0 routes to Phase 4

**Nudge cadence (enforced by heartbeat):**

| Elapsed since last outbound | Action |
|-----------------------------|--------|
| < 24h | Wait |
| ≥ 24h | Heartbeat → Nudge 1 + HR alert |
| ≥ 48h | Heartbeat → Nudge 2 + HR alert |
| ≥ 72h | Heartbeat → Case stalled, HR notified, automation stops |

**Tools used:** None (passive wait), `sharepoint_write_file` (audit-log)

---

### PHASE 4 — Process candidate reply

**Steps 22–25** *(entry point for `heartbeat_reply_detected` triggers)*

1. Confirm sender = `employee_email` OR `alternate_candidate_email` (Step 22)
   - Unknown sender → notify HR, log `reply_from_alternate_sender`, do not proceed
2. Classify reply (Step 23):
   - Acknowledgement only ("will send tonight") → `candidate_acknowledged`, wait for actual submission
   - Partial submission → `partial_submission_received` → Phase 5
   - Complete submission → `complete_submission_received` → Phase 5
   - Question/clarification → notify HR, keep status active
   - Withdrawal → `withdrawn`, notify HR, STOP
   - Cancellation → `cancelled`, notify HR, STOP
3. Append classification row to audit-log (Step 24)
4. Post issue comment (Step 25)

**Tools used:** `outlook_read_email` (via document-validator skill), `outlook_send_email`, `sharepoint_write_file`

---

### PHASE 5 — Document checklist validation

**Steps 26–30**

Uses the `document-validator` skill.

For each submitted file checks: presence, readability, correct document type, identity fields visible, no name mismatch, not password-protected, not empty, not duplicate.

FTE-specific: payslip count (3 months), multiple employer docs, relieving letters.

**Identity verification decision table (Step 29):**

| Scenario | Outcome | Action |
|----------|---------|--------|
| Name exact match | pass | No action |
| Name differs by middle name / initials only | warning | Flag, notify HR, allow provisional acceptance pending human review |
| Name differs significantly | fail | Add to discrepancy list, notify HR immediately, reject document |
| DOB exact match | pass | No action |
| DOB missing from document | warning | Flag as warning, note in case-tracker |
| DOB mismatch | fail | Add to discrepancy list, notify HR immediately |
| `date_of_birth` not provided in payload | skip | Skip DOB check, note "DOB not provided — check skipped" |

Result: `identity_check_outcome: pass | warning | fail`

**Data sensitivity:** Never log Aadhaar/PAN digits — "Aadhaar received ✓" only.

Updates case-tracker Document Tracker and Identity Verification section (Step 30).

**Tools used:** `outlook_read_email`, `outlook_list_attachments`, `outlook_read_attachment`, `sharepoint_write_file`

---

### PHASE 6 — Handle discrepancies

**Steps 31–35**

If discrepancies found:
- Append `discrepancy_found` to audit-log (Step 31)
- Notify HR with summary (Step 32)
- Send resubmission email to candidate listing **exact** missing/incorrect items — never vague (Step 33)
- Append `resubmission_requested` to audit-log, status = `awaiting_resubmission` (Step 34)
- Update case-tracker Status History (Step 35)

**After Step 35: routine stops.** The heartbeat detects the candidate's next reply and re-triggers this routine at Phase 0 → Phase 4 → Phase 5 → Phase 6 (if still issues) → Phase 7 (if complete). This loop repeats until all mandatory documents are present and valid.

If no discrepancies → proceed directly to Phase 7.

**Email subject:** `"Resubmission Required – Onboarding Documents for {name}"`

**Tools used:** `outlook_send_email`, `sharepoint_write_file`

---

### PHASE 7 — Multi-round submission handling

**Step 36**

For every new reply (entered via Phase 4 after resubmission):
- Compare against already-accepted docs — do NOT re-request accepted items
- Better copy received → keep latest valid version
- Duplicate filenames → append timestamp suffix (e.g. `Aadhaar_2026-04-23T09-15-00Z.pdf`)
- All mandatory docs present and valid → `complete_submission_received` → Phase 8
- Still partial → `partial_submission_received` → return to Phase 6 → send updated resubmission request → wait for next heartbeat-detected reply

**Tools used:** via document-validator skill, `sharepoint_write_file`

---

### PHASE 8 — Human verification request

**Steps 37–42**

Once all docs validated:
- Status = `awaiting_human_verification`
- Append `human_notified` to audit-log
- Send detailed notification email to HR with: employee details, doc status, discrepancy history, reminder history, recommended action
- Create Paperclip approval request on issue (requires human to approve)
- Update case-tracker Status History
- Wait for approval

**Tools used:** `outlook_send_email`, `sharepoint_write_file`

---

### PHASE 9 — SharePoint upload (post-approval)

**Steps 43–53**

On human approval:
1. Status = `sharepoint_upload_in_progress`
2. Upload each verified doc → `02_Verified_Documents/` (with 429/503 retry, up to 3 attempts)
3. Upload each raw submission → `01_Raw_Submissions/`
4. If discrepancy notes exist → upload to `03_Exception_Notes/discrepancy-log.md`
5. If any upload fails after retries → status = escalated, notify HR with full error detail, STOP
6. Status = `uploaded_to_sharepoint`
7. Notify HR with folder path and list of uploaded files
8. Update case-tracker: mark all docs as "uploaded"

**Tools used:** `sharepoint_write_file`, `outlook_send_email`

---

### PHASE 10 — Close case

**Steps 54–59**

All must be true before closing:
- ✓ Required documents received
- ✓ Discrepancies resolved or approved by human
- ✓ Human verification complete
- ✓ SharePoint upload successful
- ✓ Notification sent to HR

Actions:
- Status = `completed`
- Append `case_completed` to audit-log
- Post final comment on issue
- Update case-tracker: CASE STATUS: COMPLETED
- Close Paperclip issue

**Tools used:** `sharepoint_write_file` (audit-log + case-tracker)

---

## 9. Routine: email-heartbeat — 30-min Polling Loop

**Trigger:** Cron every 30 minutes  
**Concurrency:** `skip_if_running` — never overlaps with itself  
**Catch-up:** `skip_missed`  
**Audit-log ownership:** Heartbeat writes to `HR-Onboarding/audit-log.csv` ONLY. It does NOT write to any per-employee `case-tracker.md` — that is owned by the onboarding routine.

---

### STEP 1 — Load active cases from audit-log

- Reads `HR-Onboarding/audit-log.csv` from SharePoint (pipe-delimited CSV, skips header row)
- Filters to non-terminal status only (skips: completed, cancelled, withdrawn, stalled, escalated, verified_by_human, sharepoint_upload_in_progress, uploaded_to_sharepoint)
- Extracts per-case: `employee_email`, `employee_full_name`, `employee_type`, `case_id`, `last_outbound_email_timestamp`, `reminder_1_sent` (bool), `reminder_2_sent` (bool), `reminder_1_sent_timestamp`, `reminder_2_sent_timestamp`, `current_status`, `human_in_loop_email`, `recruiter_or_hr_name`
- **Timestamp guard:** if `last_outbound_email_timestamp` is missing or unparseable → append 11-col warning row to audit-log, notify HR, skip case this tick

**Tools used:** `sharepoint_read_file`, `outlook_send_email` (for timestamp error alert)

---

### STEP 2 — Check for replies (per active case)

**Step 3a:** Search `from:{employee_email}` for ALL messages received after `last_outbound_email_timestamp`. Collect all, sorted chronologically oldest first.

**Step 3b (fallback):** If 3a returns nothing → search by subject `"Onboarding Documents {employee_full_name}"`. If found from unrecognized sender (not `employee_email` or `alternate_candidate_email`) → notify HR, append `reply_from_alternate_sender` row to audit-log, skip nudge. Do NOT auto-delegate.

**If replies found (one or more):**
- Process each message in chronological order
- For each: append `reply_detected` row to audit-log, POST to onboarding routine with `source: "heartbeat_reply_detected"`, `messageId`, idempotency key = `{case_id}-reply-{messageId}`
- If delegation fails: notify HR with `messageId` for manual handling
- Skip nudge check for this case

**Tools used:** `outlook_search_emails`, `sharepoint_write_file` (audit-log)

---

### STEP 3 — Nudge decision (no-reply cases)

- Compute `reference_timestamp`:
  - If `reminder_2_sent` → use `reminder_2_sent_timestamp`
  - Else if `reminder_1_sent` → use `reminder_1_sent_timestamp`
  - Else → use `last_outbound_email_timestamp`
- Compute `elapsed = now − reference_timestamp`
- If elapsed < 24h → skip, append tick row to audit-log
- If status = stalled → skip
- **Duplicate nudge check:** Inspect the already-loaded audit-log data for this `case_id` — if a `reminder_1_sent` or `reminder_2_sent` row has a timestamp within the last 24h, skip to avoid duplicate nudge. (No extra Outlook search needed — audit-log is authoritative.)

**Tools used:** None beyond data already loaded in STEP 1

---

### STEP 4 — Send nudge

**Path A — Nudge 1** (no prior nudge, 24h elapsed):
- Email to candidate: reminder email
- HR alert: first reminder notification
- Append `reminder_1_sent` row (all 11 columns) to audit-log
- Update issue comment

**Path B — Nudge 2** (Nudge 1 sent, 24h+ since Nudge 1):
- Email to candidate: urgent reminder email
- HR alert: second reminder, action may be needed
- Append `reminder_2_sent` row (all 11 columns) to audit-log
- Update issue comment

**Path C — Stall check** (both nudges sent, 24h+ since Nudge 2):
- HR alert: case stalled, manual follow-up required
- Append `case_stalled` row with **`current_status=stalled`** to audit-log
- Update issue comment
- STOP all automation for this case

**On any nudge email send failure:** notify HR, append failure row to audit-log, do NOT mark nudge as sent.

**Tools used:** `outlook_send_email`, `sharepoint_write_file`

---

### STEP 5 — Heartbeat completion log

- Appends 11-column summary row to audit-log:
  ```
  | {now} | — | — | — | — | — | — | — | heartbeat_tick | Processed {N} active cases. Replies: {R}. Nudges: {X}. Stalled: {S}. | — |
  ```

**Tools used:** `sharepoint_write_file`

---

## 10. Skill: document-validator

Called by the onboarding routine in Phase 4/5. Reusable — any agent can call it.

### Step 1 — Read email
`outlook_read_email` → body, sender, `hasAttachments`  
`outlook_list_attachments` → name, contentType, size, attachmentId per file

### Step 2 — Extract content from attachments

| File type | Extraction |
|-----------|-----------|
| PDF | `extractedText` — full plain text |
| DOCX | `extractedText` — full plain text |
| JPG/PNG/GIF/WEBP | Claude vision reads image directly |
| TXT/CSV/MD | raw text |
| HEIC/TIFF | Flagged for manual review |
| ZIP/RAR | Candidate asked to send files unzipped |

Combines: email body + all extracted text → full submission text for matching.

### Step 3 — Match against checklist
Caller provides checklist. Each item matched as `present` / `pending` / `unclear`.  
One attachment can satisfy multiple items (e.g., Aadhaar satisfies Photo ID AND Address Proof).

### Step 3b — Identity verification
Cross-check name and DOB visible on documents against `employee_full_name` and `date_of_birth`. Decision table in Phase 5 above applies. Returns `identity_check_outcome: pass | warning | fail`.

### Step 4 — Build structured result

```json
{
  "sender": { "name": "...", "email": "..." },
  "attachments": [ { "name": "...", "contentType": "...", "readable": true } ],
  "checklist": [
    { "item": "Aadhaar Card", "status": "present", "evidence": "Aadhaar card received — number [REDACTED]" },
    { "item": "PAN Card", "status": "pending", "evidence": null }
  ],
  "summary": { "total": 7, "present": 5, "pending": 1, "unclear": 1 },
  "identity_checks": {
    "name_on_documents": "...",
    "name_matches_candidate": true,
    "dob_on_documents": "...",
    "dob_matches_candidate": true,
    "cross_doc_name_consistent": true,
    "identity_check_outcome": "pass",
    "mismatches": []
  },
  "notes": "..."
}
```

**ID digits must use `[REDACTED]`** — never real numbers in evidence or notes.

### Step 5 — Reply with HTML
Caller provides template. Skill fills with actual results → `outlook_reply` with `isHtml: true`.

### Step 6 — Return result to caller
Skill only validates. Caller decides next step.

**Tools used:** `outlook_read_email`, `outlook_list_attachments`, `outlook_read_attachment`, `outlook_reply`

---

## 11. SharePoint Storage Layout

**Site:** `https://medicodio.sharepoint.com/sites/MedicodioMarketing`

```
HR-Onboarding/
├── config.md                              ← Routine IDs, config values, nudge thresholds
├── audit-log.csv                          ← All events, all cases (pipe-delimited CSV, append-only, 11 columns)
│
├── Jane Doe - 2026-05-01/                 ← One folder per employee
│   ├── case-tracker.md                    ← Per-employee tracker (status, docs, identity, nudges)
│   ├── 01_Raw_Submissions/                ← All files as submitted by candidate
│   ├── 02_Verified_Documents/             ← Files confirmed OK by human
│   └── 03_Exception_Notes/
│       └── discrepancy-log.md             ← Notes on any issues found
│
├── John Smith - 2026-06-01/
│   └── ...
```

Folder name format: `{employee_full_name} - {date_of_joining}`

**Never silently overwrite** — duplicate filenames get a timestamp suffix (e.g. `Aadhaar_2026-04-23T09-15-00Z.pdf`).

---

## 12. Audit Log

File: `HR-Onboarding/audit-log.csv`  
Format: **pipe-delimited CSV** (`|`). Opens natively in Excel — import with `|` as delimiter to get all 11 columns. Per-employee `case-tracker.md` files remain markdown.

Every action by every component appends a row. **All 11 columns are mandatory on every row — no exceptions.** Use `—` (em-dash) for fields that genuinely do not apply — never leave blank.

**Header row (written once at file creation):**
```
timestamp|case_id|employee_email|employee_full_name|employee_type|human_in_loop_email|recruiter_or_hr_name|current_status|event|action_taken|brief_reason
```

**Data rows:**
```
{timestamp}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|{current_status}|{event}|{action_taken}|{brief_reason}
```

**Append pattern:** `sharepoint_read_file path="HR-Onboarding/audit-log.csv"` → add new line → `sharepoint_write_file` with full content. (SharePoint MCP has no append-only mode.)

- `timestamp`: ISO-8601 UTC — `2026-04-23T09:15:00Z`
- `current_status`: from Status Transition Rules table (Section 7)
- `case_created` row is especially critical — the heartbeat reads `human_in_loop_email`, `recruiter_or_hr_name`, `employee_type`, and `current_status` from this row for all subsequent processing

### All valid events

| Event | Fired by |
|-------|---------|
| `case_created` | Phase 1, Step 10 |
| `initial_email_sent` | Phase 2, Step 15 |
| `awaiting_reply` | Phase 3, Step 19 |
| `candidate_acknowledged` | Phase 4, Step 23 |
| `reminder_1_sent` | Heartbeat Path A |
| `reminder_2_sent` | Heartbeat Path B |
| `reply_detected` | Heartbeat Step 4 |
| `reply_from_alternate_sender` | Heartbeat Step 3b |
| `partial_submission_received` | Phase 4, Step 23 |
| `complete_submission_received` | Phase 4/7 |
| `under_automated_review` | Phase 5, Step 26 |
| `discrepancy_found` | Phase 6, Step 31 |
| `resubmission_requested` | Phase 6, Step 34 |
| `human_notified` | Phase 6/8 |
| `human_approved` | Phase 9, Step 45 |
| `sharepoint_folder_created` | Phase 1 |
| `files_uploaded` | Phase 9, Step 51 |
| `case_completed` | Phase 10, Step 56 |
| `case_stalled` | Heartbeat Path C |
| `case_cancelled` | Phase 4 |
| `case_withdrawn` | Phase 4 |
| `escalated` | Various |
| `heartbeat_skip` | Heartbeat (timestamp guard) |
| `heartbeat_tick` | Heartbeat Step 5 |

---

## 13. Human-in-the-Loop Touchpoints

The agent notifies `human_in_loop_email` immediately in these situations:

| Situation | Phase / Routine | Action required |
|-----------|----------------|----------------|
| Unknown `employee_type` | Phase 1 | Clarify and re-trigger |
| Rehire case | Phase 1 | Confirm if prior docs reusable |
| Same-date rehire collision | Idempotency check | Confirm the new case is intended |
| Initial email send fails | Phase 2 | Send manually |
| Reply from unrecognized email | Heartbeat | Confirm if it's the candidate |
| Missing/malformed timestamp on case | Heartbeat | Review audit-log |
| Nudge 1 sent (24h no reply) | Heartbeat | Awareness only |
| Nudge 2 sent (48h no reply) | Heartbeat | May need personal follow-up |
| Case stalled (72h no reply) | Heartbeat | Manual follow-up required |
| Any discrepancy found | Phase 5/6 | Awareness; may assist candidate |
| Identity mismatch (name or DOB) | Phase 5, Step 29 | Decide whether to accept |
| Candidate asks a question | Phase 4 | Answer and forward to agent |
| Submission from unknown email | Phase 4 | Confirm sender identity |
| SharePoint folder already exists unexpectedly | Idempotency | Investigate duplicate |
| SharePoint upload fails after retries | Phase 9 | Manual upload required |
| ANY ambiguity the agent cannot resolve | Any | STOP — full context provided to HR |
| **Document verification ready** | Phase 8 | **APPROVE upload to SharePoint ← main action** |

---

## 14. Failure Handling Summary

| Failure | Where | Automated response |
|---------|-------|--------------------|
| Unknown `employee_type` | Phase 1 | Escalate to HR, STOP |
| SharePoint folder creation fails (after 3 retries) | Phase 1 | Status = escalated, notify HR, STOP |
| Initial email send fails | Phase 2 | Notify HR, status = escalated, STOP |
| audit-log unreadable | Heartbeat | Notify HR, STOP heartbeat tick |
| `outlook_search_emails` fails (one case) | Heartbeat | Append warning to audit-log, skip case, continue others |
| Nudge email send fails | Heartbeat | Notify HR, append failure row, do NOT mark nudge as sent |
| Onboarding routine trigger fails (reply) | Heartbeat | Notify HR with `messageId`, manual handling |
| Submission from unrecognized email | Phase 4 | Notify HR, wait for confirmation |
| Candidate withdraws / cancels | Phase 4 | Status update, notify HR by email, STOP |
| Document review can't complete | Phase 5 | Notify HR, status = awaiting_human_verification |
| SharePoint 429/503 | Phase 1, 9 | Wait 10s, retry up to 3×; on 3rd fail → escalate + notify HR |
| SharePoint upload fails after retries | Phase 9 | Status = escalated, full error detail to HR, STOP |
| HR manually cancels | Any | Status = cancelled, stop all automation |

---

## 15. Security & Data Sensitivity Rules

These rules apply to **every component** — routines, skills, logs, emails:

1. **Aadhaar numbers** — Never output, log, or email the digits. Use "Aadhaar received ✓" only.
2. **PAN numbers** — Same rule. Use "PAN card on file".
3. **Any government-issued ID** — Use `[REDACTED]` in exception notes if you must reference it.
4. **Reply body content** — Never echo candidate email body content into audit-log or issue comments.
5. **Employee PII in HR alerts** — HR alert emails contain name + email. Treat as internal-only.
6. **No duplicate cases** — Idempotency key `{employee_email}-{date_of_joining}` prevents this.
7. **No silent overwrites** — SharePoint files are never silently replaced (timestamp suffix added).
8. **No automatic delegation of unverified senders** — Unrecognized email senders always go to human review first.
9. **MCP credential scoping** — SharePoint credentials (`SHAREPOINT_CLIENT_ID/SECRET`) are NEVER injected into the Outlook MCP process. Outlook MCP uses its own `OUTLOOK_CLIENT_ID/SECRET` env vars. When a dedicated Mail-only app registration is created, only update `.env` — no code changes needed.

---

## 16. Full Flow Diagram (text)

```
HR creates issue (label: onboarding)
         │
         ▼
[HR Agent] detects issue → fires employee-onboarding routine
         │
         ▼
PHASE 0: Source routing gate
    ├── source = "heartbeat_reply_detected" → jump to Phase 4 (skip setup)
    └── source = "manual" / absent → proceed to Phase 1
         │
         ▼
PHASE 1: Validate inputs + create SharePoint folders + case-tracker
    ├── unknown type → escalate, STOP
    └── folder create fails (after retries) → escalate, STOP
         │
         ▼
PHASE 2: Send document request email to candidate (HTML, template by employee_type)
    └── send fails → escalate, STOP
         │
         ▼
PHASE 3: Park — heartbeat takes over polling
         │
         │◄─────────────────────────────────────────────────────────────┐
         │                                                               │
[HEARTBEAT] fires every 30 min                                          │
    ├── reads audit-log → find active cases                             │
    ├── search Outlook for ALL replies per case (chronological)         │
    │   ├── reply found → delegate each to Phase 0/4 ─────────────────┘
    │   └── no reply → nudge check (audit-log based dedup):             (routine resumed via Phase 0)
    │       ├── < 24h → wait, log tick
    │       ├── ≥ 24h, no prior nudge → Nudge 1 + HR alert
    │       ├── ≥ 48h (after Nudge 1) → Nudge 2 + HR alert
    │       └── ≥ 72h (after Nudge 2) → STALL, current_status=stalled, HR alert, stop
         │
         ▼ (on heartbeat delegating reply)
PHASE 4: Classify candidate reply
    ├── acknowledgement → wait for actual docs (heartbeat continues polling)
    ├── partial / complete submission → Phase 5
    ├── question → notify HR, wait
    └── withdrawal / cancellation → notify HR by email, STOP
         │
         ▼
PHASE 5: Document validation (document-validator skill)
    ├── read all attachments (PDF, DOCX, images via vision)
    ├── match against mandatory checklist
    ├── identity check: name + DOB decision table
    └── update case-tracker Document Tracker + Identity Verification
         │
         ├── discrepancies found?
         │       ▼
         │   PHASE 6: Notify HR + send resubmission email (exact items only)
         │       │ → routine stops → heartbeat detects next reply → Phase 0 → Phase 4 → loop
         │
         ▼ (all docs present + valid, or no discrepancies)
PHASE 7: Multi-round check
    ├── all mandatory docs now present → Phase 8
    └── still partial → Phase 6 (updated resubmission) → wait for next reply
         │
         ▼
PHASE 8: Notify HR for human verification
    ├── send detailed summary email
    ├── create Paperclip approval request
    └── wait for approval
         │
         ▼ (human approves)
PHASE 9: Upload to SharePoint (with 429/503 retry)
    ├── 02_Verified_Documents/
    ├── 01_Raw_Submissions/
    └── 03_Exception_Notes/ (if any)
         │
         ▼
PHASE 10: Close case
    ├── status = completed
    ├── audit-log: case_completed
    ├── case-tracker: CASE STATUS: COMPLETED
    ├── final issue comment
    └── close Paperclip issue
```

---

## 17. Open Questions & Gaps

| # | Gap / Question | Status | Decision / Notes |
|---|---------------|--------|-----------------|
| 1 | SharePoint folder creation fails in Phase 1 | ✅ Resolved | Phase 1 Steps 6–9 now have retry (3×) + escalate + notify HR on failure |
| 2 | Stalled cases cannot be automatically restarted | 🔲 Open | Design required: on manual restart, routine should re-read audit-log for this case_id to reconstruct context (last status, docs received, timestamps), then resume from appropriate phase. No auto-restart yet. |
| 3 | `config.md` fallback for routine ID | ✅ Done | File exists at `HR-Onboarding/config.md`. Template: `HR-SHAREPOINT-CONFIG-TEMPLATE.md`. Read via `sharepoint_read_file path="HR-Onboarding/config.md"`. |
| 4 | Hiring manager notified only if `hiring_manager_email` set | 🔲 Low priority | No default escalation path defined. Hiring manager currently passive. |
| 5 | Rehire timeout — HR doesn't reply to "reuse docs?" question | 🔲 Open | No timeout defined. Heartbeat will nudge candidate but the rehire HR-confirmation loop has no timeout. Needs a defined SLA. |
| 6 | Audit-log performance as it grows | 🔲 Future | Heartbeat reads the full file every 30 min. When it grows large, consider archiving rows older than 90 days to `audit-log-archive-{YYYY}.md`. |
| 7 | No pause/resume mechanism for a specific case | 🔲 Open | Required: a way to freeze a case (not cancel) and resume later. Possible approach: add `paused` as an exception status — heartbeat skips it, human sets it back to previous status to resume. |
| 8 | `alternate_candidate_email` — heartbeat reply search | ✅ Partially resolved | Heartbeat Step 3b now flags replies from unrecognized senders (not `employee_email`) and notifies HR. Explicit `from:{alternate_candidate_email}` search in Step 3a is a remaining gap — heartbeat does not proactively search the alternate address in 3a, only catches it via subject-line fallback in 3b. |

---

*Last updated: 2026-04-23 | Branch: karthik-dev*
