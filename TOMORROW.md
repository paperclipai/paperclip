# Tomorrow — Agent Setup Action Plan

---

## 1. Routines (Daily Agent Schedules)
**Why:** Without routines agents only wake on manual trigger. Routines = autonomous daily operation.
**Impact:** Agents work 24/7 without human intervention.

### Marketing Specialist Routines

| Routine | Schedule | What | Impact |
|---------|----------|------|--------|
| **Morning Briefing** | 8:00 AM weekdays | List SharePoint root, check unread Outlook, summarise overnight activity, post digest to CEO | CEO starts day with marketing status |
| **Contact Processing** | 10:00 AM weekdays | Read apollo contact exports from SharePoint, enrich via Apollo API, write enriched CSV back to SharePoint | Auto-process new leads daily |
| **Content Draft** | 2:00 PM weekdays | Check `Blogs Posting Group - Review/` for briefs, draft blog post or social content, save to SharePoint `Outputs/` | Consistent content pipeline |
| **EOD Report** | 6:00 PM weekdays | Summarise day's work, files created, emails sent, save to `Reports/YYYY-MM-DD-eod.md`, email CMO | Visibility on daily output |

### HR Routines

| Routine | Schedule | What | Impact |
|---------|----------|------|--------|
| **Leave Approval Check** | 9:00 AM weekdays | Open Greythr → check pending leave requests → approve/flag → email summary to manager | No leave requests sit unprocessed |
| **Attendance Report** | 9:30 AM weekdays | Greythr → pull yesterday attendance → save to SharePoint `HR/Attendance/` | Daily attendance visibility |
| **Inbox Triage** | 8:30 AM weekdays | Read unread Outlook → categorise → reply to HR queries → escalate blockers | HR emails answered same day |
| **Onboarding Check** | Mon 9:00 AM | Check any pending onboarding tasks in Paperclip → action in Greythr | New hires processed weekly |

### CEO Routines

| Routine | Schedule | What | Impact |
|---------|----------|------|--------|
| **Daily Briefing** | 7:30 AM weekdays | Fetch all agent inbox-lite → summarise in-progress work → flag blockers → post as Paperclip comment | CEO aware of all agent status daily |
| **Weekly Review** | Mon 7:00 AM | Full company dashboard → summarise week ahead → create priority issues → assign agents | Clear weekly priorities |

### CMO Routines

| Routine | Schedule | What | Impact |
|---------|----------|------|--------|
| **Marketing Review** | 11:00 AM weekdays | Read Marketing Specialist EOD reports from SharePoint → review content quality → approve/reject → email feedback | Quality control on marketing output |
| **Campaign Status** | Fri 4:00 PM | Summarise week's marketing activity → draft board update email | Weekly leadership visibility |

---

## 2. Apollo MCP (Email Finder)
**Why:** Find verified professional emails for RCM directors, healthcare contacts by name + org.
**Impact:** Marketing + HR can find anyone's email for outreach.
**Effort:** 30 min

### Action
- [ ] Get Apollo API key: `app.apollo.io → Settings → Integrations → API`
- [ ] Build `packages/mcp-apollo/` (same pattern as sharepoint/outlook)
- [ ] Tools: `apollo_search_person`, `apollo_enrich_contact`, `apollo_bulk_search`, `apollo_search_org`
- [ ] Assign to: Marketing Specialist + HR
- [ ] Add Hunter.io as fallback (free 25/mo): `hunter.io → API key`

---

## 3. HR: Employee Directory MCP
**Why:** HR needs to look up employees, managers, org structure without manual searching.
**Impact:** HR can find any employee instantly, auto-populate onboarding flows.
**Effort:** 30 min — same Azure creds, just need `User.Read.All` permission

### Action
- [ ] Azure portal → App `b99155dc` → API Permissions → Add `User.Read.All` (Application) → Admin consent
- [ ] Build `packages/mcp-directory/` using MS Graph `/users` endpoint
- [ ] Tools: `directory_search_user`, `directory_list_users`, `directory_get_manager`, `directory_get_reports`, `directory_get_org_chart`
- [ ] Assign to: HR only

---

## 4. HR: Calendar MCP
**Why:** HR needs to schedule interviews, onboarding sessions, check availability.
**Impact:** HR agent books interviews autonomously.
**Effort:** 30 min — same Azure creds

### Action
- [ ] Azure portal → Add `Calendars.ReadWrite` (Application) → Admin consent
- [ ] Build `packages/mcp-calendar/` using MS Graph `/users/{mailbox}/calendar`
- [ ] Tools: `calendar_list_events`, `calendar_create_event`, `calendar_update_event`, `calendar_delete_event`, `calendar_check_availability`, `calendar_create_meeting`
- [ ] Assign to: HR

---

## 5. Greythr Browser Automation (HR)
**Why:** HR's primary system — leave, attendance, payroll, onboarding all live here.
**Impact:** HR agent handles Greythr tasks without human login.
**Effort:** 1 hour (browser skill already built, just need creds + test)

### Action
- [ ] Get Greythr URL (e.g. `medicodio.greythr.com`)
- [ ] Get HR login credentials (email + password for service account)
- [ ] Add secrets: `GREYTHR_URL`, `GREYTHR_EMAIL`, `GREYTHR_PASSWORD`
- [ ] Update HR agent env with secret refs
- [ ] Test: assign task "Log into Greythr and list pending leave requests"
- [ ] Build specific flows: leave approval, attendance pull, new employee

---

## 6. Teams MCP
**Why:** Read team channels, post updates, monitor project discussions.
**Impact:** Agents participate in Teams without human relay.
**Effort:** 45 min — needs Azure permission + build

### Action
- [ ] Azure portal → Add permissions:
  - `Team.ReadBasic.All`
  - `ChannelMessage.Read.All`
  - `ChannelMessage.Send`
  - `Chat.Read` (delegated — for DMs, needs Microsoft approval separately)
- [ ] Build `packages/mcp-teams/` using MS Graph `/teams`, `/channels`, `/messages`
- [ ] Tools: `teams_list_teams`, `teams_list_channels`, `teams_read_channel`, `teams_post_message`, `teams_reply_thread`
- [ ] Assign to: All agents

---

## 7. Individual Agent Mailboxes
**Why:** Each agent should have own email identity for external communication.
**Impact:** Emails come from `hr@medicodio.ai`, `marketing@medicodio.ai` not personal inbox.
**Effort:** 15 min per agent (mailbox already exists or create shared mailbox)

### Action
- [ ] Create/confirm mailboxes:
  - HR → `hr@medicodio.ai`
  - Marketing Specialist → `marketing@medicodio.ai`
  - CMO → `cmo@medicodio.ai`
  - CEO → `ceo@medicodio.ai` or keep `karthik.r@medicodio.ai`
- [ ] Update `OUTLOOK_MAILBOX` secret per agent (currently all share one)
- [ ] Test each agent sends from correct mailbox

---

## 8. SharePoint for HR
**Why:** HR needs document storage — offer letters, policies, contracts, onboarding docs.
**Impact:** All HR docs organised and agent-accessible.
**Effort:** 5 min — SharePoint MCP already built, just assign + create folder structure

### Action
- [ ] Assign SharePoint skill to HR agent
- [ ] Agent task: "Create folder structure in SharePoint: `HR/Policies`, `HR/Onboarding`, `HR/Contracts`, `HR/Attendance`"

---

## Priority Order for Tomorrow

```
High impact, low effort first:

1. ⚡ Routines setup (all agents)          — highest impact, unlocks autonomy
2. ⚡ SharePoint for HR                    — 5 min, immediate value
3. 🔑 Greythr (need creds from you)        — HR's core system
4. 🔑 Apollo MCP (need API key from you)   — Marketing lead enrichment
5. 🔧 Directory + Calendar MCP             — Azure perms needed first
6. 🔧 Teams MCP                            — Azure perms needed first
7. 📬 Individual mailboxes                 — configure when ready
```

---

## Azure AD — Add All Permissions at Once

Do this once before tomorrow session:

1. Go to `portal.azure.com`
2. Azure Active Directory → App Registrations → `b99155dc-faf3-44b2-88bf-1e8bffb607a8`
3. API Permissions → Add a permission → Microsoft Graph → Application permissions
4. Add ALL of these in one go:
   - `User.Read.All`
   - `Calendars.ReadWrite`
   - `Team.ReadBasic.All`
   - `ChannelMessage.Read.All`
   - `ChannelMessage.Send`
5. Click **Grant admin consent for Medicodio AI**
6. Done — all MCPs will work without revisiting Azure

---

## Bring to Tomorrow Session

- [ ] Apollo API key (`app.apollo.io → Settings → API`)
- [ ] Greythr URL + HR login credentials
- [ ] Azure permissions done (above)
- [ ] Confirm individual mailbox addresses per agent
