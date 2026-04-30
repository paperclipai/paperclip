# Marketing Specialist — Routines

## Registered Routines

| Routine | Schedule | File |
|---------|----------|------|
| Daily Lead Outreach | 22:30 IST daily (17:00 UTC) | [daily-lead-outreach.md](daily-lead-outreach.md) |
| Event Outreach | Manual (per event) | [event-outreach.md](event-outreach.md) |

---

## Setup: Register Daily Lead Outreach in Paperclip

Run once as board operator after the marketing-specialist agent exists in your company.

### Step 1 — Get required IDs

```bash
# List agents → get marketing-specialist agent ID
pnpm paperclipai agent list

# List projects → get project ID to assign routine to
pnpm paperclipai company list
```

Or via API:
```bash
curl http://localhost:3100/api/companies/{companyId}/agents \
  -H "Authorization: Bearer {token}"
```

### Step 2 — Create the routine

```bash
curl -X POST http://localhost:3100/api/companies/{companyId}/routines \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -d '{
    "title": "Daily Lead Outreach",
    "description": "Read Apollo CSV, research leads, draft outreach emails, await approval, send on approval.",
    "assigneeAgentId": "{marketingSpecialistAgentId}",
    "projectId": "{projectId}",
    "priority": "medium",
    "status": "active",
    "concurrencyPolicy": "skip_if_active",
    "catchUpPolicy": "skip_missed"
  }'
```

Save the returned `routineId`.

### Step 3 — Add schedule trigger (10:30 PM IST = 17:00 UTC)

```bash
curl -X POST http://localhost:3100/api/routines/{routineId}/triggers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -d '{
    "kind": "schedule",
    "cronExpression": "30 17 * * *",
    "timezone": "UTC",
    "label": "22:30 IST daily"
  }'
```

### Step 4 — Create Marketing-Specialist config in SharePoint

Create file `Marketing-Specialist/config.md` in SharePoint with:

```markdown
# Marketing Specialist Config

apollo_file: apollo-contacts-export.xlsx
batch_size: 3
review_email: marketing@medicodio.site
outlook_user: marketing@medicodio.site
```

### Step 5 — Test with manual run

```bash
curl -X POST http://localhost:3100/api/routines/{routineId}/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -d '{"source": "manual", "idempotencyKey": "test-run-001"}'
```

---

## Modifying the schedule

To change trigger time (e.g. move to 9 AM IST = 03:30 UTC):

```bash
curl -X PATCH http://localhost:3100/api/routine-triggers/{triggerId} \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer {token}" \
  -d '{"cronExpression": "30 3 * * *"}'
```

IST to UTC: subtract 5 hours 30 minutes.

## Pausing / resuming

```bash
# Pause
curl -X PATCH http://localhost:3100/api/routines/{routineId} \
  -d '{"status": "paused"}'

# Resume
curl -X PATCH http://localhost:3100/api/routines/{routineId} \
  -d '{"status": "active"}'
```
