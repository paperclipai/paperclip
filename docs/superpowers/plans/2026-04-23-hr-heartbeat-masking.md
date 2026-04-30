# HR Heartbeat + Aadhaar Masking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 30-min email-polling heartbeat to the HR onboarding system, wire nudge-after-24h logic, and enforce Aadhaar/government-ID redaction across all HR agent files.

**Architecture:** A new cron routine (`email-heartbeat.md`) fires every 30 min, reads active cases from SharePoint `audit-log.md`, checks Outlook for replies, sends nudges when 24h has elapsed since last outbound email, and delegates to the existing onboarding routine phases for reply processing. The onboarding routine's Phase 3 is simplified to remove vague "check periodically" language — heartbeat owns polling. Aadhaar masking rules are added as explicit constraints in three files.

**Tech Stack:** Paperclip routines (markdown), Outlook MCP (`outlook_search_emails`, `outlook_send_email`), SharePoint MCP (`sharepoint_read_file`)

---

## File Map

| Action | File | Responsibility |
|--------|------|---------------|
| Create | `agents/hr/routines/email-heartbeat.md` | 30-min cron: read active cases, check replies, nudge after 24h |
| Modify | `agents/hr/routines/employee-onboarding.md` | Simplify Phase 3 — remove polling logic, defer to heartbeat |
| Modify | `agents/hr/AGENTS.md` | Add Aadhaar/gov-ID masking critical rule |
| Modify | `agents/hr/skills/document-validator.md` | Add masking rule to Step 4 (result object) and Step 5 (reply) |

---

## Task List

### Task 1: Create email-heartbeat routine

**Goal:** New cron routine that fires every 30 min, finds all active onboarding cases, checks for candidate replies, nudges if 24h elapsed.

**Files:**
- Create: `agents/hr/routines/email-heartbeat.md`

**Acceptance Criteria:**
- [ ] File has `trigger: cron` every 30 min
- [ ] Reads active cases from `HR-Onboarding/audit-log.md` in SharePoint
- [ ] Filters only cases with non-terminal status
- [ ] Checks `outlook_search_emails` per candidate email
- [ ] If reply found → delegates to onboarding routine Phase 4 (reply processing)
- [ ] If no reply AND `now - last_outbound_email_timestamp > 24h` → sends nudge
- [ ] If no reply AND `now - last_outbound_email_timestamp <= 24h` → does nothing, logs heartbeat tick
- [ ] Never sends duplicate nudges (checks if nudge already sent this cycle)
- [ ] Logs every action to audit-log

**Verify:** Manual test — create a test onboarding case, wait (or mock time), confirm heartbeat fires and nudge email appears after 24h threshold.

**Steps:**

- [ ] **Step 1: Write the routine file**

Create `agents/hr/routines/email-heartbeat.md` with this exact content:

```markdown
# Email Heartbeat Routine

**Trigger:** Cron — every 30 minutes  
**Concurrency policy:** `skip_if_running` — never overlap heartbeat runs  
**Catch-up policy:** `skip_missed`

---

## Purpose

Poll for candidate email replies on all active onboarding cases.  
Send a nudge if 24h has elapsed since last outbound email with no reply.  
Delegate to the onboarding routine reply-processing phases when a reply arrives.

---

## STEP 1 — Load active cases

```
1. sharepoint_read_file path="HR-Onboarding/audit-log.md"
   → Parse all rows
   → Filter rows where status NOT IN:
     completed, cancelled, withdrawn, stalled, escalated
   → For each active case, extract:
     - employee_email
     - employee_full_name
     - case_id  (= employee_email + date_of_joining)
     - last_outbound_email_timestamp  (most recent event = initial_email_sent OR reminder_1_sent OR reminder_2_sent)
     - current_status
     - human_in_loop_email
     - recruiter_or_hr_name

2. If no active cases → log: "heartbeat_tick: no active cases" → STOP
```

---

## STEP 2 — Check for replies (per case)

For each active case:

```
3. outlook_search_emails
   query: "from:{employee_email}"
   → collect messages received AFTER last_outbound_email_timestamp
   → ignore messages from before that timestamp (prior thread)

4. IF reply found:
   → log: reply_detected for {employee_email}
   → DELEGATE to onboarding routine Phase 4 (Process candidate reply)
     POST /api/routines/{ONBOARDING_ROUTINE_ID}/run
     {
       "source": "heartbeat_reply_detected",
       "payload": {
         "case_id": "{case_id}",
         "messageId": "{messageId of reply}",
         "employee_email": "{employee_email}",
         "employee_full_name": "{employee_full_name}",
         "current_status": "{current_status}"
       },
       "idempotencyKey": "{case_id}-reply-{messageId}"
     }
   → continue to next case (do NOT send nudge for this case)

5. IF no reply:
   → proceed to STEP 3 (nudge check)
```

---

## STEP 3 — Nudge decision (no reply cases only)

```
6. Compute elapsed = now - last_outbound_email_timestamp

7. IF elapsed < 24h:
   → log: heartbeat_tick: {employee_email} — {elapsed} elapsed, no nudge yet
   → skip this case

8. IF elapsed >= 24h AND current_status = stalled:
   → log: heartbeat_tick: {employee_email} — already stalled, skip
   → skip this case

9. IF elapsed >= 24h AND current_status NOT stalled:
   → check: has a nudge already been sent in the last 24h?
     outlook_search_emails query: "to:{employee_email} subject:Reminder"
     → if nudge sent within last 24h → skip (avoid duplicate nudge)
   → if no recent nudge → proceed to STEP 4
```

---

## STEP 4 — Send nudge email

```
10. Determine nudge number:
    - If reminder_1_sent NOT in audit-log for this case → this is Nudge 1
    - If reminder_1_sent in log but reminder_2_sent NOT → this is Nudge 2
    - If reminder_2_sent in log → set status = stalled, notify human, STOP

--- NUDGE 1 ---

11. outlook_send_email
    to: {employee_email}
    subject: "Reminder: Pending Onboarding Documents – {employee_full_name}"
    isHtml: true
    body:
    <p>Hi {employee_full_name},</p>
    <p>This is a reminder to share your onboarding documents requested earlier.</p>
    <p>Please send the required documents at the earliest so that we can proceed.</p>
    <p>Regards,<br>{recruiter_or_hr_name}</p>

12. outlook_send_email
    to: {human_in_loop_email}
    subject: "HR Alert: First reminder sent to {employee_full_name}"
    isHtml: true
    body:
    <p>Hi,</p>
    <p>The first reminder has been sent to <strong>{employee_full_name}</strong> ({employee_email}) as no documents were received within 24 hours.</p>
    <p>Case ID: {case_id}</p>
    <p>Regards,<br>HR Automation</p>

13. Log to audit-log: reminder_1_sent for {case_id}
14. Update issue comment: "Nudge 1 sent to {employee_email} at {timestamp}"

--- NUDGE 2 (if Nudge 1 was 24h+ ago and still no reply) ---

15. outlook_send_email
    to: {employee_email}
    subject: "Urgent Reminder: Onboarding Documents Pending – {employee_full_name}"
    isHtml: true
    body:
    <p>Hi {employee_full_name},</p>
    <p>This is a follow-up regarding your pending onboarding documents.</p>
    <p>Please share them as soon as possible to avoid any delay in your onboarding process.</p>
    <p>Regards,<br>{recruiter_or_hr_name}</p>

16. outlook_send_email
    to: {human_in_loop_email}
    subject: "HR Alert: Second reminder sent to {employee_full_name} — action may be needed"
    isHtml: true
    body:
    <p>Hi,</p>
    <p>The second (final automated) reminder has been sent to <strong>{employee_full_name}</strong> ({employee_email}).</p>
    <p>If no response is received within 24 hours, the case will be marked as <strong>stalled</strong> and manual follow-up will be required.</p>
    <p>Case ID: {case_id}</p>
    <p>Regards,<br>HR Automation</p>

17. Log to audit-log: reminder_2_sent for {case_id}
18. Update issue comment: "Nudge 2 sent to {employee_email} at {timestamp}"

--- POST-NUDGE 2: STALL ---

19. IF this was Nudge 2 AND 24h has elapsed since Nudge 2 with still no reply:
    → Set status = stalled
    → outlook_send_email to {human_in_loop_email}:
      subject: "HR Alert: Case stalled — {employee_full_name}"
      body: "No response after 2 reminders. Manual follow-up required. Case ID: {case_id}"
    → Log: case_stalled
    → STOP automated actions for this case
```

---

## STEP 5 — Heartbeat completion log

```
20. After processing all cases:
    → Append to audit-log:
    | {timestamp} | heartbeat | — | heartbeat_tick | Processed {N} active cases. Replies: {R}. Nudges: {X}. Stalled: {S}. |
```

---

## Failure handling

| Scenario | Action |
|----------|--------|
| audit-log unreadable | Notify human_in_loop for all known active cases, log error, STOP |
| outlook_search_emails fails for a case | Log warning, skip that case, continue others |
| Nudge email send fails | Notify human_in_loop_email, log failure, do not mark nudge as sent |
| Onboarding routine trigger fails | Notify human_in_loop_email with messageId for manual handling |

---

## Data sensitivity

**NEVER** output or log full Aadhaar numbers, PAN numbers, or any government-issued ID digits in heartbeat logs, email bodies, or audit entries. Use placeholders only (e.g. "Aadhaar received", not the number).
```

- [ ] **Step 2: Verify file created correctly**

Confirm `agents/hr/routines/email-heartbeat.md` exists and all sections are present: Purpose, STEP 1–5, Failure handling, Data sensitivity.

- [ ] **Step 3: Commit**

```bash
git add agents/hr/routines/email-heartbeat.md
git commit -m "feat(hr): add 30-min email heartbeat routine for onboarding cases"
```

---

### Task 2: Simplify Phase 3 in employee-onboarding routine

**Goal:** Remove the vague "check outlook_search_emails periodically" language from Phase 3 — heartbeat now owns polling. Phase 3 becomes a lightweight "waiting" declaration only.

**Files:**
- Modify: `agents/hr/routines/employee-onboarding.md` (Phase 3 section, steps 15–27)

**Acceptance Criteria:**
- [ ] Phase 3 no longer contains `outlook_search_emails` polling loop
- [ ] Phase 3 clearly states: "Polling handled by heartbeat routine — this routine resumes when heartbeat detects a reply"
- [ ] Phase 3 still contains stall/escalation status transitions (for reference) but ownership attributed to heartbeat
- [ ] Follow-up thresholds updated to match: 24h = Nudge 1, 48h = Nudge 2, 72h = stalled
- [ ] No regression to other phases

**Verify:** Read the file and confirm Phase 3 is < 20 lines and contains no active polling commands.

**Steps:**

- [ ] **Step 1: Replace Phase 3 content**

In `agents/hr/routines/employee-onboarding.md`, replace the existing PHASE 3 block (steps 15–29 approximately) with:

```markdown
## PHASE 3 — Awaiting candidate reply (owned by heartbeat)

**Polling is handled externally** by the `email-heartbeat` routine, which runs every 30 minutes.

This routine **does not poll** — it resumes when triggered by the heartbeat with a detected reply.

### Nudge thresholds (enforced by heartbeat)

| Elapsed since last outbound email | Action |
|-----------------------------------|--------|
| < 24h | No action — wait |
| ≥ 24h, no reply | Heartbeat sends Nudge 1, notifies human_in_loop |
| ≥ 48h, still no reply | Heartbeat sends Nudge 2, notifies human_in_loop |
| ≥ 72h, still no reply | Heartbeat sets status = stalled, notifies human_in_loop, stops automation |

### When heartbeat detects a reply

Heartbeat triggers this routine with:
- `source: "heartbeat_reply_detected"`
- `payload.messageId` — the Outlook message ID of the reply
- `payload.current_status` — status at time of detection

On resume → proceed directly to **PHASE 4 — Process candidate reply**.

```
15. Set status = awaiting_document_submission (if not already set)
16. Log: awaiting_reply
17. Post issue comment: "Waiting for candidate reply. Heartbeat polling active (every 30 min). Nudge threshold: 24h."
```
```

- [ ] **Step 2: Verify no polling commands remain**

Grep the file for `outlook_search_emails` — should appear **only in Phase 4 or later** (where we confirm the sender), not in Phase 3.

- [ ] **Step 3: Commit**

```bash
git add agents/hr/routines/employee-onboarding.md
git commit -m "refactor(hr): remove polling from Phase 3 — delegate to heartbeat routine"
```

---

### Task 3: Add Aadhaar masking rules

**Goal:** Explicit government-ID redaction constraint in AGENTS.md, onboarding routine, and document-validator skill.

**Files:**
- Modify: `agents/hr/AGENTS.md`
- Modify: `agents/hr/routines/employee-onboarding.md` (Phase 5 checklist validation section)
- Modify: `agents/hr/skills/document-validator.md` (Step 4 result object, Step 5 reply)

**Acceptance Criteria:**
- [ ] `AGENTS.md` Critical Rules section has explicit Aadhaar/PAN masking rule
- [ ] `employee-onboarding.md` Phase 5 has inline note: never log/output ID digits
- [ ] `document-validator.md` Step 4 result object example uses placeholder, not real digits
- [ ] `document-validator.md` Step 5 has masking reminder before `outlook_reply`

**Verify:** Grep all three files for the word "redact" or "never output" — must appear in each.

**Steps:**

- [ ] **Step 1: Update AGENTS.md Critical Rules**

In `agents/hr/AGENTS.md`, add to the `## Critical Rules` section:

```markdown
- **Government ID masking:** Never output, repeat, log, or include in any email body the digits of Aadhaar numbers, PAN numbers, or any government-issued ID. Always use placeholders (e.g. "Aadhaar received ✓", "PAN card on file") in all emails, issue comments, audit-log entries, and SharePoint notes. This applies even when referencing documents you have received and verified.
```

- [ ] **Step 2: Update employee-onboarding.md Phase 5**

In Phase 5 (Document checklist validation), after step 33 (the per-file checks), add:

```markdown
    **DATA SENSITIVITY — MANDATORY:**
    Never log, comment, or include in any email the actual digits of Aadhaar, PAN,
    or any government ID number. Record only: "Aadhaar received", "PAN received".
    Use `[REDACTED]` if you must reference a specific ID in an exception note.
```

- [ ] **Step 3: Update document-validator.md Step 4**

In `agents/hr/skills/document-validator.md`, in the Step 4 result object example, ensure the `evidence` fields for ID documents use placeholders:

Replace any example that shows an ID number with:
```json
{ "item": "Aadhaar Card", "status": "present", "evidence": "Aadhaar card received — number [REDACTED]" }
```

Add this note immediately before the result object:

```markdown
**DATA SENSITIVITY:** Never include actual Aadhaar digits, PAN digits, or any government ID number in the `evidence` field or `notes` field. Use `[REDACTED]` as a placeholder. The result object is passed to other agents and may appear in logs or emails.
```

- [ ] **Step 4: Update document-validator.md Step 5**

In Step 5 (Reply with HTML), add this constraint before the `outlook_reply` call:

```markdown
**Before sending:** Confirm the reply body contains no raw Aadhaar, PAN, or government ID digits. If the template references a received document, use "Aadhaar Card ✓" not the number itself.
```

- [ ] **Step 5: Commit**

```bash
git add agents/hr/AGENTS.md agents/hr/routines/employee-onboarding.md agents/hr/skills/document-validator.md
git commit -m "security(hr): enforce Aadhaar/government-ID redaction across all HR agent files"
```

---

## Checkpoints

### After Task 1
- [ ] `agents/hr/routines/email-heartbeat.md` exists
- [ ] File contains all 5 steps + failure handling + data sensitivity
- [ ] Nudge cadence: check=30min, nudge=24h, stall=72h

### After Task 2
- [ ] Phase 3 in onboarding routine has no `outlook_search_emails` polling
- [ ] Heartbeat ownership documented in Phase 3
- [ ] Thresholds table present

### After Task 3
- [ ] All three files contain masking rule
- [ ] No file example shows real ID digits

---

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| audit-log format inconsistent → heartbeat can't parse active cases | High | Heartbeat Step 1 has explicit failure handler: notify all known humans |
| Heartbeat fires while onboarding routine is mid-run (race condition) | Medium | `skip_if_running` concurrency policy on heartbeat; idempotency key on reply delegation |
| Duplicate nudges if heartbeat runs twice before audit-log updates | Low | Check `outlook_search_emails` for recent nudge before sending |
| Aadhaar digits leak via document-validator `notes` field | High | Masking rule in Step 4 of validator covers notes field explicitly |

---

## Open Questions (resolved)

- ✅ Heartbeat cadence: 30 min check, 24h nudge threshold (user confirmed)
- ✅ Active case source: audit-log in SharePoint (user confirmed)
- ✅ Heartbeat trigger type: separate cron routine (user confirmed)
