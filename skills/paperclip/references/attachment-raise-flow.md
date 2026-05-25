# Attachment Cap Raise Flow

## Overview

Each company has an `attachment_max_bytes` column on the `companies` table.

| Value | Meaning |
|-------|---------|
| `NULL` | Use the system default (currently **10 MB**, controlled by `PAPERCLIP_ATTACHMENT_MAX_BYTES`) |
| Non-null integer | Company-specific override in bytes, capped at **2 GB** (`MAX_ATTACHMENT_HARD_LIMIT`) |

The system default is 10 MB. Raising a company's cap is a two-step, board-approved process.

## Step 1 — Request board approval

Before writing any value to the database, an agent or operator must request board approval using the `request_board_approval` approval type. The payload must name the proposed value:

```json
POST /api/companies/{companyId}/approvals
{
  "type": "request_board_approval",
  "requestedByAgentId": "{your-agent-id}",
  "issueIds": ["{issue-id}"],
  "payload": {
    "title": "Raise attachment cap for {Company Name}",
    "summary": "Current cap is 10 MB (system default). Proposed raise to 50 MB to accommodate build artifact uploads (APKs, recording bundles).",
    "recommendedAction": "Set attachment_max_bytes = 52428800 (50 MB) on company {companyId}",
    "risks": [
      "Storage usage will increase as agents upload larger files.",
      "Storage cost impact should be reviewed before approval."
    ]
  }
}
```

## Step 2 — Operator applies the approved value

v1 is **operator-applied** — there is no API endpoint that writes the override directly. After the approval reaches `approved` status, a Paperclip operator writes the column value directly:

```sql
-- Confirm the approval is approved before running this
UPDATE companies
SET attachment_max_bytes = 52428800  -- 50 MB
WHERE id = '{companyId}';
```

Alternatively, the operator can use the company update API if the value is within the existing validator range. Future versions may add an approval-gated endpoint.

## Hard ceiling

`MAX_ATTACHMENT_HARD_LIMIT = 2 * 1024 * 1024 * 1024` (2 GB) is a platform-wide constant enforced at request-admission time in `normalizeIssueAttachmentMaxBytes`. **No company override can exceed 2 GB**, regardless of board approval. Raising this ceiling requires a code change and redeploy.

## Resetting to system default

To revert a company to the system default, set `attachment_max_bytes = NULL`:

```sql
UPDATE companies SET attachment_max_bytes = NULL WHERE id = '{companyId}';
```

## Notes

- The effective cap at upload time is `min(companyOverride ?? systemDefault, MAX_ATTACHMENT_HARD_LIMIT, PAPERCLIP_ATTACHMENT_MAX_BYTES)`.
- Board approval events are recorded in the approvals audit trail.
- No schema migration is needed for a raise — the column already accepts any value up to `MAX_ATTACHMENT_HARD_LIMIT`.
