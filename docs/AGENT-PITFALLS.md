# Paperclip Agent — Common Bugs & Pitfalls

Every issue in this doc was a real production failure. Fix these once, prevent them forever.

---

## Table of Contents

1. [MCP Config File Not Found](#1-mcp-config-file-not-found)
2. [MCP Credentials Never Reach Subprocess](#2-mcp-credentials-never-reach-subprocess)
3. [Agent CWD is Wrong — Can't Read Routine Files](#3-agent-cwd-is-wrong--cant-read-routine-files)
4. [Agent Improvises Instead of Following Routine](#4-agent-improvises-instead-of-following-routine)
5. [Double Agent Wake — Two Mechanisms Fire at Once](#5-double-agent-wake--two-mechanisms-fire-at-once)
6. [Wrong Mailbox — Email Sent From Wrong Identity](#6-wrong-mailbox--email-sent-from-wrong-identity)
7. [Agent Emails Wrong Recipient](#7-agent-emails-wrong-recipient)
8. [Missing Fields in Routine Delegation Payload](#8-missing-fields-in-routine-delegation-payload)
9. [Redundant API Calls in Phase Routing](#9-redundant-api-calls-in-phase-routing)
10. [Audit Log Format Breaks Downstream Parsing](#10-audit-log-format-breaks-downstream-parsing)
11. [Idempotency Key Not Enforced → Duplicate Runs](#11-idempotency-key-not-enforced--duplicate-runs)
12. [Apify Actor Result Never Retrieved](#12-apify-actor-result-never-retrieved)
13. [Stale MCP Paths After Repo Move](#13-stale-mcp-paths-after-repo-move)
14. [Email Deliverability — DKIM Not Configured](#14-email-deliverability--dkim-not-configured)
15. [Bad Email Addresses — Bounce Not Handled](#15-bad-email-addresses--bounce-not-handled)

---

## 1. MCP Config File Not Found

**Symptom**
```
MCP config file not found: .../_default/agents/hr/mcp.json
```

**Root Cause**

`--mcp-config agents/hr/mcp.json` is a relative path. Paperclip resolves it relative to the agent's CWD (`effectiveLocalFolder`). If the workspace CWD is not set, Paperclip uses an empty `_default` directory — relative path resolves to nothing.

**Fix**

Always use absolute paths in `extraArgs`:

```
# BAD
--mcp-config agents/hr/mcp.json

# GOOD
--mcp-config /Users/karthikkhatavkar/medicodio-paperclip/agents/hr/mcp.json
```

**Prevention Checklist for every new agent:**
- [ ] `--mcp-config` uses absolute path
- [ ] Path verified with `ls` before saving

---

## 2. MCP Credentials Never Reach Subprocess

**Symptom**

MCP server starts but immediately fails authentication. Outlook says "disconnected". SharePoint returns 401. No error about missing env vars — just silent auth failure.

**Root Cause**

MCP server processes are subprocesses. Env vars from the Paperclip agent secrets are only injected into the subprocess if they are listed in the `env` block of the server entry in `mcp.json`. Without an `env` block, the subprocess inherits nothing — it starts with a blank environment.

**Broken config (no env block):**
```json
"outlook": {
  "command": "/usr/local/bin/node",
  "args": ["/absolute/path/dist/stdio.js"]
}
```

**Fixed config:**
```json
"outlook": {
  "command": "/usr/local/bin/node",
  "args": ["/absolute/path/dist/stdio.js"],
  "env": {
    "OUTLOOK_TENANT_ID": "${SHAREPOINT_TENANT_ID}",
    "OUTLOOK_CLIENT_ID": "${OUTLOOK_CLIENT_ID}",
    "OUTLOOK_CLIENT_SECRET": "${OUTLOOK_CLIENT_SECRET}",
    "OUTLOOK_MAILBOX": "${OUTLOOK_MAILBOX}"
  }
}
```

**Prevention Checklist for every MCP server entry:**
- [ ] Every server that needs credentials has an `env` block
- [ ] Every env var the server reads is listed in the block
- [ ] Test by running `echo '{"jsonrpc":"2.0","id":1,"method":"initialize",...}' | node dist/stdio.js` manually

---

## 3. Agent CWD is Wrong — Can't Read Routine Files

**Symptom**

Agent reads `routines/email-heartbeat.md` → file not found. Agent ignores AGENTS.md instructions and improvises. All relative file reads fail silently.

**Root Cause**

Paperclip uses `effectiveLocalFolder` as the agent's CWD. If no project workspace is created (or workspace has no `cwd`), Paperclip defaults to an empty `_default` directory. Relative paths in instructions like `routines/email-heartbeat.md` resolve against this empty dir.

**Fix**

Create a project workspace in Paperclip with `effectiveLocalFolder` pointing to the repo root:

```
PATCH /api/agents/{agentId}
{
  "workspaceId": "{workspace-id-with-cwd-set-to-repo-root}"
}
```

Workspace must have:
```json
{ "cwd": "/Users/karthikkhatavkar/medicodio-paperclip" }
```

**Verification**

After fix, agent's first tool call should be able to `Read` `agents/hr/AGENTS.md` without error.

---

## 4. Agent Improvises Instead of Following Routine

**Symptom**

Agent wakes up for a cron heartbeat but starts checking GitHub issues, sending emails to the wrong people, and making up its own workflow. AGENTS.md is read but routing is ambiguous.

**Root Cause**

Two sub-causes:

**A. Wake reason not checked**  
AGENTS.md didn't explicitly tell the agent to check WHY it woke up. Without explicit routing by wake reason, the agent defaults to "do everything" mode.

**B. Trigger separation not enforced**  
Multiple triggers (cron heartbeat + issue assignment + continuation recovery) can all fire. If AGENTS.md doesn't tell the agent which trigger means which behavior, it mixes them.

**Fix**

AGENTS.md must open with explicit wake-reason routing:

```markdown
## When you wake up

**FIRST: check why you were woken.**

| Wake reason | What to do |
|-------------|------------|
| Routine run titled "Email Heartbeat" | Read `routines/email-heartbeat.md` ONLY. Do nothing else. |
| Issue assigned with label `onboarding` | Read `routines/employee-onboarding.md` ONLY. |
| Routine run titled "Employee Onboarding" | Read `routines/employee-onboarding.md` ONLY. |

**Do not combine behaviors from multiple triggers in one run.**
```

**Prevention Checklist:**
- [ ] AGENTS.md has explicit wake-reason routing table at the top
- [ ] Each trigger maps to exactly one routine file
- [ ] Each routine file says "do nothing else" at the start

---

## 5. Double Agent Wake — Two Mechanisms Fire at Once

**Symptom**

Two agent runs start within seconds of each other. One is the scheduled cron heartbeat. The other is Paperclip's continuation recovery (automatic retry of an in-progress issue). Both try to process the same case. Race conditions, duplicate emails, duplicate audit-log entries.

**Root Cause**

Paperclip has two independent wake mechanisms:
1. **Cron routine** — fires on schedule
2. **Continuation recovery** — if an issue is in `in_progress` state when the agent goes idle, Paperclip auto-retries it

If an issue stays `in_progress` after a run, continuation recovery fires every time the cron wakes the agent too.

**Fix**

When a human review step is needed (or a case is waiting for a candidate reply), move the issue to `in_review` — NOT `in_progress`. `in_review` does not trigger continuation recovery.

```
Waiting for candidate reply  → set issue status to in_review
Waiting for human approval   → set issue status to in_review
Active work happening        → in_progress is fine
```

**Prevention Checklist:**
- [ ] Onboarding routine sets `in_review` when delegating to heartbeat polling
- [ ] Heartbeat does not leave cases `in_progress` after finishing

---

## 6. Wrong Mailbox — Email Sent From Wrong Identity

**Symptom**

Marketing Specialist sends emails from `karthik.r@medicodio.ai` instead of `marketing@medicodio.site`. HR agent emails land in karthik's sent folder. Drafts appear in wrong mailbox.

**Root Cause**

`OUTLOOK_MAILBOX` secret was shared between HR and Marketing Specialist agents. Both agents pointed to the same secret (karthik's mailbox). Marketing agent never had its own mailbox secret defined.

**Fix**

Each agent needs its own `OUTLOOK_MAILBOX` secret:

| Agent | Secret name | Value |
|-------|-------------|-------|
| HR | `outlook-mailbox-hr` | `karthik.r@medicodio.ai` |
| Marketing Specialist | `outlook-mailbox-marketing` | `marketing@medicodio.site` |

In each agent's secret bindings, set `OUTLOOK_MAILBOX` to point to the correct agent-specific secret.

**Prevention Checklist for every new agent that uses Outlook:**
- [ ] Agent has its own `OUTLOOK_MAILBOX` secret
- [ ] Secret value is verified before first run
- [ ] After first test run, confirm email appears in correct mailbox Sent folder

---

## 7. Agent Emails Wrong Recipient

**Symptom**

HR agent was supposed to email candidate (Ananya) asking for documents, but instead drafted an email to the HR manager (Murali) and CCed karthik. Core task not done.

**Root Cause**

Agent read the issue body but misidentified roles. `recruiter_or_hr_email` (Murali) is in the issue data. Without an explicit instruction distinguishing "send document request TO candidate, send notification CC to HR", the agent took the first email it found and emailed that person.

**Fix**

AGENTS.md and routine files must explicitly state which email goes to which party:

```markdown
## Email routing rules

- **Document request** → send TO `employee_email` (the candidate)
- **HR notification** → send TO `human_in_loop_email`, CC `recruiter_or_hr_email`
- **NEVER** send document requests to HR or recruiter email addresses
```

In routine steps, make it unambiguous:

```markdown
## Step 2 — Send document request email

`outlook_send_email`
- to: `{employee_email}`   ← THE CANDIDATE, not HR
- cc: never CC anyone on this email
```

**Prevention Checklist:**
- [ ] Every email step names the `to:` field explicitly with the variable
- [ ] Routine comment explains WHO each email goes to
- [ ] First test run: verify candidate email was delivered to candidate

---

## 8. Missing Fields in Routine Delegation Payload

**Symptom**

Heartbeat delegates reply to onboarding routine. Onboarding routine runs Phase 4 but writes malformed audit-log rows — missing `employee_type`, `human_in_loop_email`, `recruiter_or_hr_name` columns. Downstream STEP 1 parsing in next heartbeat tick fails to find active cases correctly.

**Root Cause**

When the heartbeat `POST`s to trigger the onboarding routine, the payload only included `case_id`, `messageId`, `employee_email`, `employee_full_name`. Fields like `employee_type` were not included — the onboarding routine had no source for them when writing audit-log entries.

**Fix**

Delegation payload must include ALL fields needed by the downstream routine for audit-log writes:

```json
{
  "case_id": "...",
  "messageId": "...",
  "employee_email": "...",
  "employee_full_name": "...",
  "employee_type": "...",
  "human_in_loop_email": "...",
  "recruiter_or_hr_name": "...",
  "alternate_candidate_email": "... or null",
  "current_status": "..."
}
```

**Prevention Checklist:**
- [ ] Count audit-log columns (11) and verify every delegation payload provides all 11
- [ ] Delegation payload schema matches audit-log column order
- [ ] Test: after delegation, check audit-log row has no `—` in required fields

---

## 9. Redundant API Calls in Phase Routing

**Symptom**

Phase 4 of the onboarding routine calls `outlook_search_emails` even though the heartbeat already found the email and passed `messageId` in the payload. Wastes tokens, adds latency, occasionally finds the wrong email.

**Root Cause**

Phase 4 header said "find the reply email" without specifying the source. Agent defaulted to searching Outlook again instead of using the `messageId` already in the payload.

**Fix**

Every phase that receives a delegation payload must explicitly state which fields come from the payload vs. which require an API call:

```markdown
## Phase 4 — Process Reply

**Source:** Called by heartbeat via routine trigger.

**Payload fields available (DO NOT re-fetch these):**
- `messageId` — use directly with `outlook_read_email messageId="{messageId}"`
- `employee_email`, `employee_full_name`, `employee_type` — use from payload
- `current_status` — use from payload

**DO NOT call `outlook_search_emails` again.** The message is already identified.
```

---

## 10. Audit Log Format Breaks Downstream Parsing

**Three sub-bugs, all real:**

### 10a. Wrong delimiter (comma instead of pipe)

Heartbeat STEP 1 uses `|` (pipe) as delimiter. If any row is written with `,` (comma), the parser reads garbage. Always: **pipe-delimited, never comma**.

```
# WRONG
2026-04-23T09:00:00Z,case-id,email@example.com,...

# CORRECT
2026-04-23T09:00:00Z|case-id|email@example.com|...
```

### 10b. Wrong file extension

SharePoint file was `audit-log.md` instead of `audit-log.csv`. The heartbeat path `HR-Onboarding/audit-log.csv` would return 404. Always check: **path in AGENTS.md must match actual SharePoint file**.

### 10c. Missing columns → malformed rows

Audit log has 11 required columns. Missing any column shifts subsequent columns, breaking field parsing. If a field doesn't apply, use em-dash `—` (not empty string, not blank).

```
# WRONG (blank fields)
2026-04-23T09:00:00Z|—||—|...

# CORRECT (em-dash for N/A)
2026-04-23T09:00:00Z|—|—|—|—|—|—|—|heartbeat_tick|No active cases|—
```

**Prevention Checklist:**
- [ ] Audit-log path in AGENTS.md ends in `.csv`
- [ ] SharePoint file actually named `audit-log.csv`
- [ ] Every routine that appends to audit-log counts its columns = 11
- [ ] Em-dash `—` used for N/A fields, never blank

---

## 11. Idempotency Key Not Enforced → Duplicate Runs

**Symptom**

Same employee onboarded twice. Two `case_created` rows in audit-log for same `employee_email`. Candidate receives two initial emails.

**Root Cause**

Heartbeat fired twice (e.g., double wake from bug #5) and each wake triggered the onboarding routine. If the idempotency key wasn't properly formed or the routine trigger didn't check for existing `case_created` rows, it created a duplicate case.

**Fix**

Idempotency key format: `{employee_email}-{date_of_joining}`

Before creating a new case, ALWAYS check audit-log for existing `case_created` row with same `case_id`:

```markdown
## Phase 1 — Case Setup

1. Read `HR-Onboarding/audit-log.csv`
2. Search for rows where `case_id = {employee_email}-{date_of_joining}` AND `event = case_created`
3. **If found: STOP. Case already exists. Post comment on issue and exit.**
4. Only proceed if no existing case_created row.
```

Include idempotency key in every `POST /api/routines/{id}/run` call:
```json
{
  "idempotencyKey": "{employee_email}-{date_of_joining}"
}
```

---

## 12. Apify Actor Result Never Retrieved

**Symptom**

Agent calls `apify_call_actor` and then hangs or moves on without results. No output used. Task effectively did nothing.

**Root Cause**

Apify actors run asynchronously. `apify_call_actor` returns a `runId` or `datasetId`, not the actual results. If the agent doesn't call `get-actor-output` afterward, results are never read.

Additionally, slow actors cause MCP timeout (`-32000: Connection closed`). Agent treats this as failure and stops — but actor is still running.

**Fix**

AGENTS.md must include mandatory follow-up rule:

```markdown
## Apify MCP Rules

After EVERY `apify_call_actor` call — no exceptions:

```
get-actor-output  datasetId="<datasetId from response>"  limit=50
```

For slow actors (scraping, large exports):
```
apify_call_actor  actorId="..."  input={...}  async=true
# → get runId from response
get-actor-output  runId="<runId>"  limit=50
```

`-32000: Connection closed` = timeout, actor still running.
→ Call `get-actor-output runId="<runId>"` to recover. Do NOT retry the actor call.
```

---

## 13. Stale MCP Paths After Repo Move

**Symptom**

CEO and CMO agents fail to load MCP servers. Error: `Cannot find module '/Users/karthikkhatavkar/paperclip/paperclip/packages/...'`

**Root Cause**

Repo was moved from `/Users/karthikkhatavkar/paperclip/paperclip/` to `/Users/karthikkhatavkar/medicodio-paperclip/`. CEO and CMO `mcp.json` files still reference the old path.

**Current broken state** (CEO, CMO):
```json
"args": ["/Users/karthikkhatavkar/paperclip/paperclip/packages/mcp-sharepoint/dist/stdio.js"]
```

**Should be:**
```json
"args": ["/Users/karthikkhatavkar/medicodio-paperclip/packages/mcp-sharepoint/dist/stdio.js"]
```

**Fix:** Update `agents/ceo/mcp.json` and `agents/cmo/mcp.json` — see [Action Items](#action-items) below.

**Prevention:** When moving repo, run:
```bash
grep -r "paperclip/paperclip" agents/ --include="*.json"
```
to find all stale paths before the first agent run.

---

## 14. Email Deliverability — DKIM Not Configured

**Symptom**

Outbound emails from `marketing@medicodio.site` land in spam or are rejected. NDR header shows:
```
authentication-results: dkim=none (message not signed) header.d=none
```

**Root Cause**

DKIM signing is not enabled for the `medicodio.site` domain in Microsoft 365. Without DKIM, receiving mail servers cannot cryptographically verify the email is legitimately from Medicodio. Cold outreach emails + no DKIM = very high spam rate.

**Fix (DNS + Exchange Admin)**

1. Go to Microsoft 365 Admin Center → Settings → Domains → `medicodio.site`
2. Enable DKIM in Exchange Admin Center under Email Authentication
3. Microsoft generates two CNAME records — add them to DNS at your registrar
4. Verify: send test email, check headers for `dkim=pass`

Also verify SPF and DMARC:
- SPF: `TXT @ "v=spf1 include:spf.protection.outlook.com -all"`
- DMARC: `TXT _dmarc "v=DMARC1; p=quarantine; rua=mailto:dmarc@medicodio.site"`

**This is not a code fix — requires DNS admin access.**

---

## 15. Bad Email Addresses — Bounce Not Handled

**Symptom**

Email sent successfully from agent. NDR arrives in marketing mailbox:
```
Error: 550 5.1.1 User Unknown
Recipient Address: eali@northwell.edu
```

**Root Cause**

`550 5.1.1` = recipient email address does not exist at the destination domain. Bad data in prospect list. Agent has no bounce detection — it just continues to next contact.

**Fix (Data)**

Mark the row in the prospect Excel as `BOUNCED` in the status column. Do not retry this address.

**Fix (Agent behavior)**

Add to Marketing Specialist AGENTS.md:

```markdown
## Handling bounced emails

When checking the marketing mailbox and you find NDR (non-delivery report) emails:
1. Extract `Recipient Address` from NDR body
2. Find that address in the prospect Excel file on SharePoint
3. Update their row: set `Email Status` column = `BOUNCED`, `Outreach Status` = `Invalid`
4. Do NOT retry sending to bounced addresses
5. Log action in issue comment: "Marked {email} as BOUNCED in prospect list"
```

---

## Action Items — Fixes Not Yet Applied

| # | Issue | File | Status |
|---|-------|------|--------|
| 13 | Stale MCP paths | `agents/ceo/mcp.json` | ✅ Fixed 2026-04-24 |
| 13 | Stale MCP paths | `agents/cmo/mcp.json` | ✅ Fixed 2026-04-24 |
| 2  | Missing env blocks (sharepoint + outlook) | `agents/ceo/mcp.json` | ✅ Fixed 2026-04-24 |
| 2  | Missing env blocks (sharepoint + outlook) | `agents/cmo/mcp.json` | ✅ Fixed 2026-04-24 |
| 2  | Missing env block (hunter) | `agents/marketing-specialist/mcp.json` | ✅ Fixed 2026-04-24 |
| 14 | DKIM not configured | DNS / Exchange Admin | ❌ Needs admin action |
| 10b | Audit-log file extension | SharePoint `HR-Onboarding/audit-log.csv` | ✅ Fixed 2026-04-24 — renamed via Graph API |
| - | Wrong SharePoint files from bad test run | SharePoint `HR-Onboarding/Ananya Gowdar - 2026-05-01` | ✅ Fixed 2026-04-24 — folder deleted |

---

---

## Fix Log — Applied 2026-04-24

### CEO + CMO: Stale MCP paths + missing env blocks (Bug #13 + Bug #2)

**Files changed:** `agents/ceo/mcp.json`, `agents/cmo/mcp.json`

Both files had two compounding bugs:
1. Paths referenced the old repo location (`/paperclip/paperclip/`) — MCP servers could not start at all.
2. Even with correct paths, no `env` block meant credentials were never injected into subprocess — sharepoint and outlook would 401 silently.

**Why this won't recur:** Both fixes are structural. The path is now the canonical absolute path for this machine. The env blocks mirror the HR agent's proven-working pattern — every new agent must copy this pattern (enforced by the New Agent Checklist below). A grep check (`grep -r "paperclip/paperclip" agents/`) should be run after any repo move.

### Marketing Specialist: Hunter MCP missing env block (Bug #2)

**File changed:** `agents/marketing-specialist/mcp.json`

Hunter MCP reads `HUNTER_API_KEY` from env. Without the `env` block, the subprocess had no API key, all email-find calls would fail silently. Added `env: { HUNTER_API_KEY: "${HUNTER_API_KEY}" }`.

**Why this won't recur:** The New Agent Checklist now explicitly requires an env block on every MCP server that reads from env. Hunter MCP source (`packages/mcp-hunter/src/config.ts:1`) is authoritative — `process.env.HUNTER_API_KEY` is the only secret it reads.

---

## New Agent Checklist

Use this when creating any new Paperclip agent:

```
MCP Config
[ ] --mcp-config uses ABSOLUTE path
[ ] Every MCP server that needs credentials has an env{} block
[ ] All required env vars listed in the block
[ ] Test MCP manually: echo init JSON | node dist/stdio.js

Working Directory
[ ] Project workspace created with explicit cwd = repo root
[ ] Agent can read its own AGENTS.md without error

Routing
[ ] AGENTS.md has wake-reason routing table at the top
[ ] Each trigger maps to exactly one routine
[ ] Each routine says "do nothing else" at the start

Email
[ ] Agent has its own OUTLOOK_MAILBOX secret (not shared)
[ ] Mailbox secret value verified
[ ] Every email step names to: field explicitly
[ ] First run: verify email in correct mailbox Sent folder

Audit / Logging
[ ] Log format is pipe-delimited (never comma)
[ ] Column count = required columns
[ ] Em-dash for N/A fields

Idempotency
[ ] Case creation checks for existing case_created row first
[ ] All routine triggers include idempotencyKey

Deliverability (if sending cold outreach)
[ ] DKIM enabled for sending domain
[ ] SPF record correct
[ ] DMARC policy set
```

---

## Quick Diagnostic — Agent Not Working

```
Agent woke but did nothing useful?
→ Check AGENTS.md wake-reason routing (Bug #4)
→ Check CWD / routine files readable (Bug #3)

MCP tool call fails immediately?
→ Check env{} block in mcp.json (Bug #2)
→ Check absolute path in --mcp-config (Bug #1)

Two agent runs at once?
→ Check issue status — move to in_review if waiting (Bug #5)

Email from wrong address?
→ Check OUTLOOK_MAILBOX secret binding (Bug #6)

Email to wrong person?
→ Check routine email routing rules (Bug #7)

Audit-log parsing broken?
→ Check delimiter, column count, file extension (Bug #10)

Duplicate cases?
→ Check idempotency key + case_created row check (Bug #11)

Apify actor no output?
→ Call get-actor-output after every actor call (Bug #12)
```
