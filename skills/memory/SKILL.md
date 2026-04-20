---
name: memory
description: >
  Read and write persistent memory across runs. Each agent has its own memory
  file in SharePoint. Use at the start of every run to recall context, and at
  the end to save what happened. Prevents repeating work, forgetting contacts,
  or losing decisions between daily runs.
---

# Memory Skill

Agent memory lives in SharePoint at `Agent-Memory/[agent-name]-memory.md`.
Read it first. Write it last. Every run.

---

## Your Memory File Path

| Agent | File |
|-------|------|
| Marketing Specialist | `Agent-Memory/marketing-specialist-memory.md` |
| HR | `Agent-Memory/hr-memory.md` |
| CEO | `Agent-Memory/ceo-memory.md` |
| CMO | `Agent-Memory/cmo-memory.md` |

---

## Start of Every Run — READ MEMORY

```
sharepoint_read_file path="Agent-Memory/[your-agent-name]-memory.md"
```

If file not found → first run, no memory yet. Create it at end of run.

---

## End of Every Run — WRITE MEMORY

```
sharepoint_write_file
  path="Agent-Memory/[your-agent-name]-memory.md"
  content="[updated memory]"
```

Always overwrite the full file with updated content.

---

## Memory File Format

```markdown
# [Agent Name] Memory
Last updated: YYYY-MM-DD

## Contacts
<!-- People researched, emailed, replied -->
- John Smith | RCM Director | Surgicare ASC | john@surgicare.com | emailed 2026-04-17 | no reply yet
- Jane Doe | Admin | City Surgical | jane@citysurgical.com | replied 2026-04-15 | interested, follow up May

## Decisions Made
<!-- Choices that should persist -->
- Using domain1 for ASC outreach, domain2 for hospital outreach
- Skip contacts with < 50 employee companies

## Work In Progress
<!-- Tasks started but not finished -->
- Apollo export from 2026-04-16 → processed 12/40 contacts

## Do Not Contact
<!-- Bounced, unsubscribed, wrong person -->
- noreply@healthsystem.com — bounced
- mark@asc.com — replied "not interested", DNC

## Notes
<!-- Anything else worth remembering -->
- Surgicare corporate has 8 locations — treat as one account
```

---

## Rules

- **Read memory before doing any work** — avoids duplicate emails, repeating research.
- **Check contacts list before emailing** — if person already emailed, check status first.
- **Check DNC list before emailing** — never email a DNC contact.
- **Write memory after every run** — even if nothing happened, update "Last updated" date.
- **Keep it concise** — memory file should stay under 200 lines. Summarise old entries.
- **Never store credentials** — only store context, decisions, contact history.

---

## Quick Patterns

### Check if contact already emailed
Read memory → search contacts section for name/email → if found, check status → decide action.

### Log a sent email
Add to contacts: `Name | Title | Company | email | emailed YYYY-MM-DD | awaiting reply`

### Log a reply
Update existing contact line: `... | replied YYYY-MM-DD | [summary of reply]`

### Log a bounce
Move contact to DNC: `email — bounced YYYY-MM-DD`

### Save a decision
Add to "Decisions Made": one line, what and why.
