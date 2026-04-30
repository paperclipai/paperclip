# Employee Onboarding Routine

**Trigger:** API-triggered — fired by HR agent heartbeat when onboarding issue detected, or manually  
**Concurrency policy:** `always_enqueue` — each employee is a separate independent run  
**Catch-up policy:** `skip_missed`

---

## Global Conventions

- **Timestamps:** All timestamps MUST be ISO-8601 UTC format: `YYYY-MM-DDTHH:MM:SSZ` (e.g. `2026-04-23T09:15:00Z`). Never use local time or ambiguous formats.
- **Audit-log:** Every event MUST append a full 12-column CSV row to `HR-Onboarding/audit-log.csv`. See Audit Log Format section.
- **CSV append pattern:** `sharepoint_read_file path="HR-Onboarding/audit-log.csv"` → append new pipe-delimited line → `sharepoint_write_file path="HR-Onboarding/audit-log.csv"` with full updated content. Delimiter is `|`. Never use comma as delimiter.
- **Government ID masking:** Never output, log, or include in any email the digits of Aadhaar, PAN, or any government ID. Use placeholders only: "Aadhaar received ✓", "PAN card on file". Use `[REDACTED]` if you must reference a specific ID in an exception note.
- **HTML emails:** All emails sent by this routine MUST use `isHtml: true`. Never send plain text.
- **Binary file uploads (CRITICAL):** When uploading PDFs, images, or any non-text file from Outlook to SharePoint, ALWAYS use `sharepoint_transfer_from_outlook` — one call with messageId + attachmentId + destPath. It streams bytes server-side; binary never enters the context window. NEVER use `outlook_read_attachment` + `sharepoint_upload_binary` for files — base64 gets truncated for anything over ~75 KB.

---

## Inputs — Where to Read Them

**CRITICAL — read order (do NOT skip steps):**

1. Check `PAPERCLIP_WAKE_PAYLOAD_JSON` env var first. If present, parse it and extract the `payload` field — all employee data lives there when fired by heartbeat or API.
2. If `PAPERCLIP_WAKE_PAYLOAD_JSON` is absent or has no `payload`, call `GET /api/issues/{PAPERCLIP_TASK_ID}/heartbeat-context` and extract employee fields from the run payload embedded in the context.
3. If still no employee data found, scan the issue body for `employee_full_name:`, `employee_email:` etc. key-value lines.
4. If none of the above yield the required fields → post blocked comment listing missing fields, notify `karthik.r@medicodio.ai`, STOP.

**Never assume the issue description contains employee data.** Paperclip creates execution issues with the routine's static description — employee data comes from the run payload.

### Required fields
| Field | Description |
|---|---|
| `employee_full_name` | Full name |
| `employee_email` | Primary email |
| `role` | Job role/designation |
| `employee_type` | `intern` \| `fresher` \| `fte` \| `experienced` \| `contractor` \| `rehire` |
| `date_of_joining` | Confirmed joining date (ISO format) |
| `recruiter_or_hr_name` | HR/recruiter name |
| `recruiter_or_hr_email` | HR/recruiter email |
| `human_in_loop_name` | Human reviewer name |
| `human_in_loop_email` | Human reviewer email |
| `phone_number` | Candidate's contact phone number |

### Optional
`alternate_candidate_email`, `date_of_birth` (ISO format, e.g. `1995-06-15` — used for doc identity verification in Phase 5), `hiring_manager_name`, `hiring_manager_email`, `business_unit`, `location`, `joining_mode`, `notes_from_hr`, `special_document_requirements`

---

## SharePoint Base Path

```
HR-Onboarding/{employee_full_name} - {date_of_joining}/
```

---

## Case ID (Idempotency)

Unique case = `{employee_email}-{date_of_joining}`  
Example: `jane.doe@example.com-2026-05-01`

**Before starting:**
1. `sharepoint_list_folder path="HR-Onboarding"` → check if folder `{employee_full_name} - {date_of_joining}` exists
2. If YES and case is active → do not duplicate; continue existing case
3. If YES and case is `completed` → check if this is a rehire (see Rehire Collision below)
4. If NO → proceed to Phase 1

### Rehire Collision Handling

If a `completed` case already exists for `{employee_email} + {date_of_joining}` (same person, same date — rare but possible), the idempotency key collides.

Resolution:
- Suffix the case ID with `-rehire-{N}` where N starts at 1 and increments (e.g. `jane.doe@example.com-2026-05-01-rehire-1`)
- Check if `-rehire-1` also exists; if so, try `-rehire-2`, and so on
- Notify `human_in_loop_email` immediately:
  - subject: `HR Alert: Same-date rehire case detected for {employee_full_name}`
  - body: `<p>A completed onboarding case already exists for <strong>{employee_full_name}</strong> ({employee_email}) with joining date {date_of_joining}.</p><p>A new case is being created as a rehire with Case ID: {new_case_id}. Please confirm this is intended before proceeding.</p>`
- Use the suffixed case ID for all audit-log rows and SharePoint paths for this run

---

## Status Model

Update issue comment on every status change.

`initiated` → `initial_email_sent` → `awaiting_document_submission` → `candidate_acknowledged` → `partial_submission_received` → `complete_submission_received` → `under_automated_review` → `discrepancy_found` → `awaiting_resubmission` → `awaiting_human_verification` → `verified_by_human` → `sharepoint_upload_in_progress` → `uploaded_to_sharepoint` → `completed`

Exception statuses: `stalled` | `escalated` | `withdrawn` | `cancelled`

---

## Status Transition Rules

Every audit-log row MUST use the `current_status` value from this table for the given event. Never guess — use exactly the value listed here.

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
| `human_notified` | current status unchanged — do not update |
| `human_approved` | `verified_by_human` |
| `sharepoint_folder_created` | `initiated` |
| `files_uploaded` | `uploaded_to_sharepoint` |
| `case_completed` | `completed` |
| `case_stalled` | `stalled` |
| `case_cancelled` | `cancelled` |
| `case_withdrawn` | `withdrawn` |
| `escalated` | `escalated` |
| `heartbeat_tick` | current status unchanged |

---

## PHASE 0 — Source routing gate

**This is the first thing the routine checks on every trigger.**

```
Step 1. Read `source` and `messageId` from the run payload (PAPERCLIP_WAKE_PAYLOAD_JSON → payload field).

IF source == "api" AND messageId is present (non-empty string):
  → This is a heartbeat-triggered reply run — do NOT run Phase 1/2/3
  → Extract from payload: case_id, messageId, employee_email, employee_full_name,
    employee_type, recruiter_or_hr_name, recruiter_or_hr_email,
    human_in_loop_email, date_of_joining, current_status, phone_number
  → Skip Phase 1, Phase 2, Phase 3 entirely
  → Jump directly to PHASE 4 — Process candidate reply
  → (Do NOT re-create folders, re-send emails, or re-log case_created)

IF source == "manual" OR (source == "api" AND messageId is absent or empty):
  → This is a fresh onboarding trigger
  → Proceed to PHASE 1 — Validate inputs
```

---

## PHASE 1 — Validate inputs

```
Step 2. Parse all required fields from payload.

Step 3. If employee_type not in allowed list (intern, fresher, fte, experienced, contractor, rehire):
   → outlook_send_email to human_in_loop_email
     subject: "HR Alert: Unknown employee_type for {employee_full_name}"
     isHtml: true
     body: <p>Hi,</p><p>Cannot proceed with onboarding for <strong>{employee_full_name}</strong> — unrecognized employee_type: <strong>{value}</strong>.</p><p>Please correct the issue type and re-trigger the routine.</p><p>Regards,<br>HR Automation</p>
   → Append to audit-log.csv (CSV append pattern):
     {now}|{case_id}|{employee_email}|{employee_full_name}|unknown|{human_in_loop_email}|{recruiter_or_hr_name}|escalated|escalated|Stopped — unknown employee_type|employee_type={value}
   → STOP

Step 4. If employee_type == rehire:
   → outlook_send_email to human_in_loop_email
     subject: "HR Alert: Rehire case — {employee_full_name}"
     isHtml: true
     body: <p>Hi,</p><p>A rehire onboarding case has been created for <strong>{employee_full_name}</strong> ({employee_email}).</p><p>Please confirm whether prior documents can be reused, or if a full new submission is required. Reply to this email to proceed.</p><p>Regards,<br>HR Automation</p>
   → Await reply before sending full document request
   → Documents required for rehire: Resume, Updated Address, Address Proof, Updated PAN/Aadhaar if changed, Full Name, Email, DOB

Step 5. Set status = initiated

Step 6. sharepoint_create_folder parentPath="HR-Onboarding" folderName="{employee_full_name} - {date_of_joining}"

Step 7. sharepoint_create_folder parentPath="HR-Onboarding/{employee_full_name} - {date_of_joining}" folderName="01_Raw_Submissions"

Step 8. sharepoint_create_folder parentPath="HR-Onboarding/{employee_full_name} - {date_of_joining}" folderName="02_Verified_Documents"

Step 9. sharepoint_create_folder parentPath="HR-Onboarding/{employee_full_name} - {date_of_joining}" folderName="03_Exception_Notes"

Step 10. Append to audit-log (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|initiated|case_created|Onboarding case initialised — folders created in SharePoint|—|{PAPERCLIP_TASK_ID}

Step 11. Create per-employee case tracker:
    sharepoint_write_file
    path="HR-Onboarding/{employee_full_name} - {date_of_joining}/case-tracker.md"
    content:
    ---
    # Onboarding Case Tracker — {employee_full_name}
    **CASE STATUS: IN PROGRESS**

    | Field | Value |
    |-------|-------|
    | Name | {employee_full_name} |
    | Email | {employee_email} |
    | Phone | {phone_number} |
    | Role | {role} |
    | Type | {employee_type} |
    | Joining Date | {date_of_joining} |
    | HR Contact | {recruiter_or_hr_name} |
    | HR Contact Email | {recruiter_or_hr_email} |
    | Case ID | {case_id} |

    ## Status History
    | Timestamp | Status | Notes |
    |-----------|--------|-------|
    | {now} | initiated | Case created |

    ## Document Tracker
    (Updated automatically at each submission. Status: pending / received / verified / rejected / uploaded)

    | Document | Required | Status | Submitted At | Issues | Verified |
    |----------|----------|--------|-------------|--------|---------|
    {document_rows_by_employee_type}

    ## Identity Verification
    | Check | Result | Notes |
    |-------|--------|-------|
    | Name on documents matches candidate | pending | — |
    | DOB on documents matches provided DOB | pending | — |
    | Name consistent across all documents | pending | — |

    ## Reminders Sent
    | Nudge | Sent At | Response |
    |-------|---------|---------|
    | Nudge 1 | — | — |
    | Nudge 2 | — | — |

    ## Attachment Lookup
    (One row appended per accepted attachment each round. Phase 9 uses the most recent row per filename to re-fetch bytes for docs accepted in earlier runs.)

    | Filename | Message ID | Attachment ID | Content Type | Round |
    |----------|-----------|---------------|-------------|-------|
    ---
```

---

## PHASE 2 — Send initial email

**HTML formatting rule:** All emails MUST use `isHtml: true`. Use `<p>` for paragraphs, `<ol><li>` for numbered lists, `<strong>` for bold, `<br>` for signature line breaks.

Select template based on `employee_type`:

### Intern / Fresher template

```
Subject: Documents Required for Onboarding – {employee_full_name}
isHtml: true
Body:
<p>Hi {employee_full_name},</p>
<p>Good day!!!</p>
<p>As discussed, please find below the list of documents that need to be sent as soon as possible.</p>
<p><strong>List of Documents:</strong></p>
<ol>
  <li>Latest Resume</li>
  <li>Passport Size Photo (Soft Copy)</li>
  <li>Education Certificates: SSLC to Highest Education</li>
  <li>PAN Card (Scan Copy)</li>
  <li>Passport Scan Copy (If Applicable)</li>
  <li>Permanent and Temporary Address (Detailed Address)</li>
  <li>Address Proof (Aadhar, DL, or Voter ID). Aadhar Card copy is mandatory.</li>
</ol>
<p><strong>Please also share the following details:</strong></p>
<ul>
  <li>Full Name</li>
  <li>Email ID</li>
  <li>DOB</li>
</ul>
<p>For any clarifications, please contact the undersigned.</p>
<p>Regards,<br>{recruiter_or_hr_name}</p>
```

### FTE / Experienced template

```
Subject: Documents Required for Onboarding – {employee_full_name}
isHtml: true
Body:
<p>Hi {employee_full_name},</p>
<p>Good day!!!</p>
<p>As discussed, please find below the list of documents that need to be sent as soon as possible.</p>
<p><strong>Required Documents:</strong></p>
<ol>
  <li>Highest Qualification Certificate</li>
  <li>All Companies Offer Letter / Appointment Letter</li>
  <li>3 Months Payslips</li>
  <li>All Companies Relieving Letter</li>
  <li>Aadhar Card (Mandatory)</li>
  <li>PAN Card</li>
  <li>Address Proof (Any one: Rental Agreement, Electricity Bill, Gas Bill, Phone Bill)</li>
</ol>
<p><strong>Please also share the following details:</strong></p>
<ul>
  <li>Full Name</li>
  <li>Email ID</li>
  <li>DOB</li>
</ul>
<p>For any clarifications, please contact the undersigned.</p>
<p>Regards,<br>{recruiter_or_hr_name}</p>
```

### Contractor template

```
Subject: Documents Required for Onboarding – {employee_full_name}
isHtml: true
Body:
<p>Hi {employee_full_name},</p>
<p>Good day!!!</p>
<p>Please share the following documents for your onboarding:</p>
<ol>
  <li>Latest Resume</li>
  <li>PAN Card</li>
  <li>Aadhar Card</li>
  <li>Address Proof</li>
  <li>Full Name, Email ID, DOB</li>
  [IF special_document_requirements is provided AND not empty:
    <li>Additional requirements: {special_document_requirements}</li>
  ELSE: omit this item entirely — never output "{special_document_requirements if any}" verbatim]
</ol>
<p>Regards,<br>{recruiter_or_hr_name}</p>
```

```
Step 12. outlook_send_email
    → to: {employee_email}
    → ccRecipients: ["{recruiter_or_hr_email}"]
    → subject + body from template above
    → isHtml: true
    → on failure: outlook_send_email to human_in_loop_email immediately, append to audit-log.csv with current_status=escalated, STOP

Step 13. Set status = initial_email_sent

Step 14. Record timestamp of sent email as initial_email_sent_timestamp

Step 15. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|initial_email_sent|initial_email_sent|Document request email sent|{employee_type} template used

Step 16. Post issue comment: "Initial email sent to {employee_email} at {now}"

Step 17. Update case-tracker Status History:
    sharepoint_write_file (append row)
    path="HR-Onboarding/{employee_full_name} - {date_of_joining}/case-tracker.md"
    → Add row: | {now} | initial_email_sent | Document request email sent to {employee_email} |
```

---

## PHASE 3 — Awaiting candidate reply (polling owned by heartbeat)

**Email polling is handled externally** by the `email-heartbeat` routine, which runs every 30 minutes.

This routine does **not** poll for replies directly — it resumes when the heartbeat detects a reply and triggers it with `source: "heartbeat_reply_detected"`.

### Nudge thresholds (enforced by heartbeat)

| Time elapsed since last outbound email | Action |
|----------------------------------------|--------|
| < 24h | No action — wait |
| ≥ 24h, no reply | Heartbeat sends Nudge 1, notifies human_in_loop |
| ≥ 48h, still no reply | Heartbeat sends Nudge 2, notifies human_in_loop |
| ≥ 72h, still no reply | Heartbeat sets status = stalled, notifies human_in_loop, stops automation |

```
Step 18. Set status = awaiting_document_submission (if not already set)

Step 19. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|awaiting_document_submission|awaiting_reply|Routine paused — heartbeat polling active|Nudge cadence: 24h/48h/stalled at 72h

Step 20. Post issue comment: "Waiting for candidate reply. Heartbeat polling active (every 30 min). Nudge cadence: Nudge 1 at 24h, Nudge 2 at 48h, stalled at 72h."

Step 21. On heartbeat resume (source = "api" with messageId in payload) → proceed to PHASE 4.
```

**Note:** If the case reaches `stalled` status, all automated actions stop. Human must manually intervene and update the issue to restart the process.

---

## PHASE 4 — Process candidate reply

**Entry point when triggered by heartbeat with `source: "api"` AND `messageId` present in payload.**

Use skill: [`skills/document-validator.md`](../skills/document-validator.md)  
→ Use `messageId` from payload directly — do NOT call `outlook_search_emails` again  
→ `outlook_read_email messageId="{messageId}"` → get full body and sender  
→ `outlook_list_attachments messageId="{messageId}"` → get attachment list  
→ Match attachments against checklist → decide next action

```
Step 22. Confirm sender is employee_email or alternate_candidate_email.
    → if neither: outlook_send_email to human_in_loop_email, do not proceed without approval
    → Append to audit-log.csv (CSV append pattern):
      {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|awaiting_document_submission|reply_from_alternate_sender|Notified human — reply from unrecognized sender|Sender: {actual_sender}

Step 23. Classify reply:
    - "Acknowledgement only" (e.g., "noted", "will send by evening", "sending tomorrow"):
      → set status = candidate_acknowledged
      → Append to audit-log.csv (CSV append pattern):
        {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|candidate_acknowledged|candidate_acknowledged|Candidate acknowledged — no documents yet|—
      → do NOT treat as submission; continue waiting via heartbeat
    - Partial submission → set status = partial_submission_received → continue to PHASE 5
    - Complete submission → set status = complete_submission_received → continue to PHASE 5
    - Question / clarification → outlook_send_email to human_in_loop_email, keep status active
    - Withdrawal / postponement:
      → set status = withdrawn
      → outlook_send_email to human_in_loop_email
      → Append to audit-log.csv (CSV append pattern):
        {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|withdrawn|case_withdrawn|Candidate withdrew / postponed|—
      → STOP
    - Cancellation:
      → set status = cancelled
      → outlook_send_email to human_in_loop_email
      → Append to audit-log.csv (CSV append pattern):
        {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|cancelled|case_cancelled|Candidate or HR cancelled onboarding|—
      → STOP

Step 24. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|{partial_or_complete_status}|{event}|Candidate reply classified: {classification}|{attachment_count} attachments received

Step 25. Post issue comment with classification and what was received.
```

---

## PHASE 5 — Document checklist validation

**Mandatory docs by type:**

| Type | Mandatory |
|---|---|
| intern/fresher | Resume, Photo, Education Certs, PAN, Address (perm+temp), Aadhar, Address Proof, Full Name, Email, DOB |
| fte/experienced | Highest Qual Cert, Offer/Appointment Letters, 3 Payslips, Relieving Letters, Aadhar, PAN, Address Proof, Full Name, Email, DOB |
| contractor | Resume, PAN, Aadhar, Address Proof, Full Name, Email, DOB |
| rehire | Resume, Updated Address, Address Proof, PAN/Aadhar if changed, Full Name, Email, DOB |

```
Step 26. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|under_automated_review|under_automated_review|Document validation started|{N} attachments to review

Step 27. For each received file, check:
    a. Presence (is it there?)
    b. File readable / not corrupt
    c. File matches expected document type
    d. Required identity fields visible (name, DOB where applicable)
    e. No obvious name mismatch across documents
    f. Not password protected
    g. Not empty attachment
    h. Not duplicate of already accepted file

    For FTE/experienced also check:
    - Payslip count appears to be 3 months
    - Multiple employer docs if expected
    - Relieving letters not obviously missing

Step 28. Build discrepancy list if any of these are true:
    - Mandatory doc missing
    - Unreadable / corrupt scan
    - Wrong doc uploaded
    - Missing Full Name / Email / DOB
    - Aadhar missing when mandatory
    - PAN missing when mandatory
    - Password-protected file
    - Obvious name mismatch
    - Insufficient pages

    Note: Do NOT claim legal compliance verification. Surface-level checks only.
    Escalate anything uncertain to human_in_loop_email.

    DATA SENSITIVITY — MANDATORY:
    Never log, comment, or include in any email the actual digits of Aadhaar, PAN,
    or any government ID number. Record only: "Aadhaar received ✓", "PAN received ✓".

Step 29. Run identity verification (using document-validator skill Step 3b):
    Cross-check name and DOB visible on submitted documents against:
    - employee_full_name from payload
    - date_of_birth from payload (if provided) or from candidate's email body

    Apply this decision table:

    | Scenario | Outcome | Action |
    |----------|---------|--------|
    | Name exact match | pass | No action |
    | Name differs by middle name / initials only | warning | Flag, notify human_in_loop_email, allow provisional acceptance pending human review |
    | Name differs significantly (different name) | fail | Add to discrepancy list, notify human immediately, do NOT accept document |
    | DOB exact match | pass | No action |
    | DOB missing from document | warning | Flag as warning in identity_checks, note in case-tracker |
    | DOB mismatch | fail | Add to discrepancy list, notify human immediately |
    | date_of_birth not provided in payload | skip | Skip DOB check entirely, note "DOB not provided — check skipped" in result |

    identity_check_outcome: pass | warning | fail

    Record result in identity_checks object as per document-validator skill Step 4.

Step 30. Update per-employee case-tracker Document Tracker:
    sharepoint_write_file (overwrite full file)
    path="HR-Onboarding/{employee_full_name} - {date_of_joining}/case-tracker.md"
    → Update each document row: received / verified / rejected / pending
    → Update Identity Verification section with results from Step 29
    → Add row to Status History: | {now} | under_automated_review | Validated {N} documents. Present: {X}. Issues: {Y}. identity_check_outcome: {outcome} |
    → For each attachment in the document-validator result, append a row to the Attachment Lookup table:
      | {attachment.name} | {attachment.messageId} | {attachment.attachmentId} | {attachment.contentType} | {reply_index} |
      (reply_index comes from the run payload — use 1 for the first reply, 2 for the second, etc.)
      Never remove or overwrite existing rows — only append. If the same filename appears again (resubmission), add a new row; Phase 9 will use the most recent row for that filename.
```

---

## PHASE 6 — Handle discrepancies

```
IF discrepancies found:

Step 31. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|discrepancy_found|discrepancy_found|{N} discrepancies found|{brief list of issues}

Step 32. outlook_send_email to human_in_loop_email
    subject: "HR Alert: Discrepancies found — {employee_full_name}"
    isHtml: true
    body:
    <p>Hi,</p>
    <p>Discrepancies were found during document review for <strong>{employee_full_name}</strong> ({employee_email}).</p>
    <ul>{discrepancy items as list}</ul>
    <p>A resubmission request has been sent to the candidate. Case ID: {case_id}</p>
    <p>Regards,<br>HR Automation</p>

Step 33. outlook_send_email to employee_email
    subject: "Resubmission Required – Onboarding Documents for {employee_full_name}"
    isHtml: true
    body:
    <p>Hi {employee_full_name},</p>
    <p>Thank you for sharing your documents.</p>
    <p>We found some issues. Please re-send or correct the following:</p>
    <ol>{exact list of missing/incorrect items — never vague, never "some documents are missing"}</ol>
    <p>Please share corrected documents at the earliest.</p>
    <p>Regards,<br>{recruiter_or_hr_name}</p>

Step 34. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|awaiting_resubmission|resubmission_requested|Resubmission email sent to candidate|{N} items to correct

Step 35. Update case-tracker Status History:
    → Add row: | {now} | awaiting_resubmission | Resubmission requested — {N} items. |

→ IMPORTANT: After Step 35, the routine STOPS and awaits the next candidate reply.
  The heartbeat will detect the candidate's resubmission and re-trigger this routine
  with source="api" + messageId in payload, which enters at PHASE 4 → PHASE 5 → PHASE 6
  (if issues remain) → PHASE 7 (if all complete).
  This loop repeats until all mandatory documents are present and valid.

IF no discrepancies → proceed directly to PHASE 7.
```

---

## PHASE 7 — Multi-round submission handling

**Reached when a resubmission is received after Phase 6, OR when Phase 5 finds no discrepancies.**

```
Step 36. For each new reply from candidate (entered via Phase 4):
    - Compare against already accepted docs (do NOT ask again for accepted docs)
    - If better copy received, keep latest valid version
    - If duplicate filename, append timestamp suffix (do not silently overwrite):
      e.g. Aadhaar_2026-04-23T09-15-00Z.pdf
    - If all mandatory docs now present and valid → set status = complete_submission_received → proceed to Phase 8
    - If still partial → set status = partial_submission_received
      → Append to audit-log.csv (CSV append pattern):
        {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|partial_submission_received|partial_submission_received|Still waiting on {N} documents|{list of still-missing items}
      → Return to Phase 6 (discrepancy handling) to send updated resubmission request
      → Heartbeat will detect next reply and re-enter at Phase 4
```

---

## PHASE 8 — Human verification

```
Step 37. Set status = awaiting_human_verification

Step 38. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|awaiting_human_verification|human_notified|All docs received — human verification requested|—

Step 39. outlook_send_email to human_in_loop_email
    subject: "HR Action Required: Verify onboarding documents for {employee_full_name}"
    isHtml: true
    body includes:
    - employee_full_name, employee_email, phone_number, role, employee_type, date_of_joining
    - current_status
    - summary_of_action_taken
    - missing_documents (if any)
    - discrepancy_summary (if any)
    - candidate_response_summary
    - reminder_1_sent: Yes/No
    - reminder_2_sent: Yes/No
    - human_action_required: Yes
    - recommended_next_step: "Please verify documents and approve upload to SharePoint"

Step 40. Create Paperclip approval on current issue:
    → title: "Verify onboarding documents for {employee_full_name}"
    → body: checklist progress + discrepancy summary
    → required approver: human_in_loop_email user

Step 41. Update case-tracker Status History:
    → Add row: | {now} | awaiting_human_verification | All docs received. Pending human review and SharePoint upload approval. |

Step 42. Wait for approval.
```

---

## PHASE 9 — SharePoint upload (on approval)

**Critical rule:** Never transform, OCR-extract, or summarise attachment content before upload.
Always download the original binary file from Outlook and store it verbatim in SharePoint.
Never write an empty file — validate non-zero size before every write.

```
Step 43. On human approval received:

Step 44. Set status = sharepoint_upload_in_progress

Step 45. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|sharepoint_upload_in_progress|human_approved|Human approved — SharePoint upload started|—

Step 46. For each verified document, follow this exact sequence:

    STEP 46a — Resolve (messageId, attachmentId) for this file:
    - If processed in Phase 5 of THIS run → use messageId + attachmentId already in context.
    - If accepted in a PREVIOUS run → read case-tracker.md Attachment Lookup table,
      find the MOST RECENT row where Filename = {filename}, extract messageId + attachmentId.

    STEP 46b — Transfer directly from Outlook to SharePoint (up to 3 attempts):
    sharepoint_transfer_from_outlook
    messageId="{messageId}"
    attachmentId="{attachmentId}"
    destPath="HR-Onboarding/{employee_full_name} - {date_of_joining}/02_Verified_Documents/{filename}"
    mimeType="{expected MIME type — e.g. application/pdf, image/jpeg, image/png}"
    → Returns: { name, size, transferredBytes, webUrl }
    → On HTTP 429 or 503: wait 10 s, retry. After 3 failures → escalate (see Step 49), skip this file.
    → Do NOT use outlook_read_attachment + sharepoint_upload_binary — binary would pass through context window and fail for large files.

    STEP 46c — Post-upload integrity check:
    sharepoint_get_file_info
    filePath="HR-Onboarding/{employee_full_name} - {date_of_joining}/02_Verified_Documents/{filename}"
    → Confirm returned size > 0.
    → If size = 0 or file not found → delete the empty file, escalate via Step 49.

Step 47. For each raw submission file, apply the identical 46a–46c sequence:
    Target destPath: "HR-Onboarding/{employee_full_name} - {date_of_joining}/01_Raw_Submissions/{filename}"
    Use sharepoint_transfer_from_outlook (same single-call pattern — NOT outlook_read_attachment + sharepoint_upload_binary)

Step 48. If any discrepancy notes exist:
    sharepoint_write_file
    path="HR-Onboarding/{employee_full_name} - {date_of_joining}/03_Exception_Notes/discrepancy-log.md"

Step 49. Escalation on any unrecoverable failure (download, validation, or upload):
    → set status = escalated
    → Append to audit-log.csv (CSV append pattern):
      {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|escalated|escalated|Phase 9 failure after retries|Path: {path} Stage: {46b|46c|46d|46e} Error: {error}
    → outlook_send_email to human_in_loop_email:
      subject: "HR Alert: SharePoint upload failure — {employee_full_name}"
      body: folder path, filename, failure stage, error detail, files successfully uploaded so far
    → Continue to next file (do NOT stop entire upload for one failed file unless ALL files fail)
    → If ALL files fail → STOP, leave status = escalated

Step 50. Set status = uploaded_to_sharepoint

Step 51. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|uploaded_to_sharepoint|files_uploaded|All files uploaded to SharePoint|{N} files

Step 52. outlook_send_email to human_in_loop_email:
    subject: "Onboarding documents uploaded — {employee_full_name}"
    isHtml: true
    body:
    <p>Hi,</p>
    <p>Documents have been uploaded to SharePoint for <strong>{employee_full_name}</strong>.</p>
    <p>Folder: HR-Onboarding/{employee_full_name} - {date_of_joining}</p>
    <p>Files uploaded:</p><ul>{list of filenames}</ul>
    <p>Regards,<br>HR Automation</p>

Step 53. Update case-tracker:
    → Update Document Tracker rows: status = "uploaded" for all uploaded docs
    → Add row to Status History: | {now} | uploaded_to_sharepoint | {N} files uploaded to SharePoint |
```

---

## PHASE 10 — Send completion email and close case

```
Step 54. All of the following must be true before completing:
    ✓ Required documents received
    ✓ Discrepancies resolved or approved by human
    ✓ Human verification complete
    ✓ SharePoint upload successful
    ✓ Notification sent to human_in_loop_email

Step 54a. Send onboarding completion email to the candidate.
    Recipients:
        - employee_email (primary)
        - Any additional email addresses on file for this candidate (e.g. personal email if provided)
    Subject: "Onboarding Completed – Next Steps"
    Body:
        Dear {employee_full_name},

        We are pleased to confirm that your onboarding process has been successfully completed.

        Your joining date is {date_of_joining}. Further details regarding your next steps — including reporting instructions,
        system access, and any pre-joining formalities — will be shared with you shortly via email.

        If you have any questions or require any changes, please reply to this email and our HR team will assist you promptly.

        Welcome aboard!

        Warm regards,
        HR Team
        Medicodio AI

    Log:
        - Email sent status (success / failure)
        - Timestamp of send
        - Recipient list (all addresses emailed)
    On failure: notify human_in_loop_email immediately, append failure row to audit-log.csv, do NOT close case.

Step 54b. Send IT setup notification email.
    Recipients:
        - IT_SUPPORT_EMAIL (from env — itadmin@medicodio.ai)
        - human_in_loop_email (HR reviewer, CC)
        - recruiter_or_hr_email (CC)
    Subject: "New Joiner IT Setup Required – {employee_full_name} ({role}) – Joining {date_of_joining}"
    Body:
        Hi IT Team,

        Please be informed that a new team member is joining Medicodio AI and requires full IT setup to be ready before their
        joining date.

        New Joiner Details:
        - Name:            {employee_full_name}
        - Role:            {role}
        - Date of Joining: {date_of_joining}
        - Employee Type:   {employee_type}
        - Phone Number:    {phone_number}
        - Contact Email:   {employee_email}

        Action Required — please ensure the following are ready by {date_of_joining}:
        1. Laptop / workstation provisioned and configured
        2. Company email account created ({employee_full_name}@medicodio.ai or as per naming convention)
        3. Required software and tools installed for role: {role}
        4. Access provisioned to relevant systems, repositories, and internal tools
        5. VPN / remote access configured if applicable
        6. Any role-specific hardware or peripherals arranged

        Please keep everything ready before the joining date. If you need any additional information, reach out to
        {recruiter_or_hr_name} at {recruiter_or_hr_email}.

        Regards,
        HR Team
        Medicodio AI

    Log:
        - Email sent status (success / failure)
        - Timestamp of send
        - Recipients list
    On failure: log warning, notify human_in_loop_email, continue case closure (non-blocking).

Step 55. Set status = completed

Step 56. Append to audit-log.csv (CSV append pattern):
    {now}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|completed|case_completed|Onboarding case closed — all docs verified and uploaded. Completion email sent to candidate. IT setup notification sent.|{recipient_list}

Step 57. Post final issue comment: "Onboarding case completed for {employee_full_name}. SharePoint folder: HR-Onboarding/{employee_full_name} - {date_of_joining}. Completion email sent to: {recipient_list}. IT setup notification sent to: {IT_SUPPORT_EMAIL}"

Step 58. Final case-tracker update:
    → Add row to Status History: | {now} | completed | Onboarding complete. All docs verified, uploaded. Completion email sent to candidate. IT setup notification sent to IT team and HR. |
    → Update header to show: **CASE STATUS: COMPLETED**

Step 59. Update Paperclip issue → done
```

---

## Failure handling

| Scenario | Action |
|---|---|
| Initial email fails | Notify human immediately, append escalated row to audit-log, STOP |
| Reminder fails | Notify human, keep case active |
| Document review can't complete | Notify human, set status = awaiting_human_verification |
| SharePoint upload fails after retries | Set status = escalated, notify human with full error summary |
| HR manually stops | Set status = cancelled, stop all reminders |

---

## Notify human_in_loop_email immediately when

- No reply after first reminder
- No reply after second reminder
- employee_type unclear
- Submission from unexpected email
- Any discrepancy found
- Candidate asks a process question
- Document unavailable / candidate requests extension
- Name mismatch found
- Rehire case (needs prior-record decision)
- SharePoint folder already exists unexpectedly
- Duplicate workflow detected

---

## Audit Log Format

File: `HR-Onboarding/audit-log.csv`  
Format: **pipe-delimited CSV** (`|`). Never use comma as delimiter.

**Header row (first line of file — written once at creation):**
```
timestamp|case_id|employee_email|employee_full_name|employee_type|human_in_loop_email|recruiter_or_hr_name|current_status|event|action_taken|brief_reason|paperclip_issue_id
```

**ALL 12 columns are mandatory on every row — no exceptions:**
```
{timestamp}|{case_id}|{employee_email}|{employee_full_name}|{employee_type}|{human_in_loop_email}|{recruiter_or_hr_name}|{current_status}|{event}|{action_taken}|{brief_reason}|{paperclip_issue_id}
```

- `paperclip_issue_id`: Paperclip UUID of the issue that triggered this run (`PAPERCLIP_TASK_ID`). Use `—` for rows written by heartbeat when no issue ID is available. **Legacy rows (11 columns, no `paperclip_issue_id` column):** treat as valid — read and preserve them as-is, append new rows with all 12 columns. Never rewrite or pad old rows.

**Append pattern:** `sharepoint_read_file` → add new line at end → `sharepoint_write_file` with full content.

- `timestamp`: ISO-8601 UTC — e.g. `2026-04-23T09:15:00Z`
- `current_status`: must match the Status Transition Rules table above for the given event
- Use `—` (em-dash) for fields that genuinely do not apply — never leave blank

Events: `case_created`, `initial_email_sent`, `awaiting_reply`, `candidate_acknowledged`, `reminder_1_sent`, `reminder_2_sent`, `reply_from_alternate_sender`, `partial_submission_received`, `complete_submission_received`, `under_automated_review`, `discrepancy_found`, `resubmission_requested`, `human_notified`, `human_approved`, `sharepoint_folder_created`, `files_uploaded`, `case_completed`, `case_stalled`, `case_cancelled`, `case_withdrawn`, `escalated`, `heartbeat_tick`

**The `case_created` row MUST include all fields** — the heartbeat reads `human_in_loop_email`, `recruiter_or_hr_name`, `employee_type`, and `current_status` from this row to know who to notify and how to handle active cases.
