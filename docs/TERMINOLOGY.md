# Terminology — UI vs Code Vocabulary

This document maps user-facing terms to their code/database counterparts.
When the two diverge, this file is the source of truth.

**Why this exists:** Renaming a core entity across a 200+ file codebase is
expensive and high-risk. When the cost outweighs the benefit, we keep the
code name stable and translate at the UI layer. This file documents those
translations so new engineers don't get confused.

## Mission <-> Issue

| Where | Term |
|---|---|
| UI (pages, buttons, toasts, errors shown to users) | **Mission / Missions** |
| Database tables and columns | `issues`, `issue_comments`, `issue_id`, etc. |
| API routes | `/api/issues/*` |
| TypeScript types | `Issue`, `IssueStatus`, `IssuePriority` |
| React component names | `IssueDetail`, `IssuesList`, `NewIssueDialog` |
| Route paths | `/issues`, `/issues/:id` |
| Keyboard shortcut scopes | `Issues` |
| Agent playbook language | "Mission" (agents talk to users) |
| Agent instruction seed files | "Issue" is acceptable (internal) |

### When writing code

- **UI code:** If the string is shown to a user, write "Mission". If it is
  a code identifier, prop key, URL, or CSS class, leave as `issue`.
- **Server code:** Error messages returned in `res.json({ error: ... })`
  should say "Mission" because they surface to the UI. Internal log
  messages can say "issue" (developer-facing).
- **Schema migrations:** Keep DB identifiers as `issue*`. Add a
  `COMMENT ON TABLE issues IS 'User-facing name: "Mission"'` clause when
  creating or altering the table.
- **Agent playbooks:** When an agent's chat output goes to users, it says
  "Mission." When an agent's internal reasoning references the data
  layer, "issue" is acceptable.

### Why we didn't rename everything

- 10 tables, ~95 columns, 22 API routes, 77 services, 35 UI components,
  15 types, 60 test files would need coordinated changes.
- Risk of half-broken state mid-deploy with 12 live agents.
- Zero user or revenue benefit (users don't see the DB schema).
- Precedent: Linear calls their entity "issues" in code, users call them
  "tickets" — nobody's confused.

### Future rename (if ever)

If a rename becomes justified (e.g., building a public API where the
mismatch confuses integration partners), do it in one atomic PR:
1. DB migration renaming tables, columns, FKs, indexes
2. Drizzle schema rewrite
3. All API route renames
4. All service + component renames
5. All test updates
6. Agent instruction seed updates
7. Deploy during a planned maintenance window

Until then, this doc is the contract.

## Tasks stay as Tasks

"Task" is consistent between UI and code. No translation needed.

## Other potentially confusing terms

| UI Term | Code Term | Notes |
|---|---|---|
| Mission | Issue | See above |
| Knowledge Base page | `knowledge_pages` | Aligned |
| Library file | `library_files` | Aligned |
| Playbook chunk | `knowledge_chunks` | New table, RAG-chunked sections of playbook pages |
| Agent | `agents` | Aligned |
| Board | `companies` | Legacy — "Company" is also used in DB |

## Maintenance

When you add a new entity where UI and code diverge, add it to this doc.
If the divergence becomes too large to track, reconsider renaming.

Last reviewed: 2026-04-14
