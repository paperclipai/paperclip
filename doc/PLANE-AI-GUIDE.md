# Plane Integration Guide for AI Agents

This document enables any AI agent working on the Paperclip Evolution roadmap to read, update, and manage work items in Plane.

## Quick Reference

| Resource          | Value                                                    |
|-------------------|----------------------------------------------------------|
| Plane URL         | `http://plane.nexus.local`                               |
| API Base          | `http://plane.nexus.local/api/v1`                        |
| Auth Header       | `X-Api-Key: <token>` (note: header is case-insensitive)  |
| Workspace Slug    | `nous`                                                   |
| Project ID        | `6ea59a32-3d6a-4602-81bd-0df63db085a5`                   |
| Project Identifier| `PEV` (Paperclip Evolution)                              |
| User ID           | `96722f4c-b026-4bfa-84c8-2f00e6485f44` (chrisfaig)      |

> **Important**: The API token must be provided by the user or read from environment variable `PLANE_API_KEY`. Never hardcode tokens in code.

## Authentication

```bash
curl -H "X-Api-Key: $PLANE_API_KEY" \
     -H "Content-Type: application/json" \
     http://plane.nexus.local/api/v1/users/me/
```

The v1 API uses `APIKeyAuthentication` (defined in `plane.api.middleware.api_authentication`). The header name is `X-Api-Key`. Django normalizes headers case-insensitively.

## DNS Requirement

The machine must resolve `plane.nexus.local` to `192.168.50.18`. Add to `/etc/hosts` if not present:
```
192.168.50.18 plane.nexus.local
```

---

## Project Structure

### States (Workflow)

| State UUID                             | Group       | Name        |
|----------------------------------------|-------------|-------------|
| `20e43ed5-651d-4d21-9800-8591204d5ce3` | backlog     | Backlog     |
| `1bd18247-2025-49d1-830f-873864658341` | unstarted   | Todo        |
| `9242f915-72b6-402d-8923-118e8b5d2898` | started     | In Progress |
| `8ac06912-fc0f-4338-92a4-f17fa62dc7f8` | completed   | Done        |
| `4fc993f5-e834-4649-bd38-7910cc5669da` | cancelled   | Cancelled   |

### Labels

| Label UUID                             | Name           |
|----------------------------------------|----------------|
| `ffebdfb0-aa2a-47f9-8c65-5eb01f3a29de` | Feature        |
| `279a0cc3-c85b-4cc8-a854-121ca38fea42` | Epic           |
| `98ab186b-9196-4137-9390-0f7de57ef435` | Security       |
| `beeb8f83-0c9d-4f4c-8456-67b6131ca60e` | Infrastructure |
| `75732288-0a72-43fb-899b-8a05fa87ac1f` | Integration    |
| `4dc76708-d891-4634-8b30-d5692371a6d3` | Plugin         |
| `52580ca4-9126-4946-b726-55809216a032` | AI-Gateway     |
| `a564277e-8fa9-4afb-bb6d-b57ebe495157` | Documentation  |
| `92a7f172-4ac3-4f70-afa2-0fed19044244` | Tech Debt      |
| `f55846ed-5db2-48d3-844c-b6ff8b40089c` | UX/UI          |

### Modules (Phases)

| Module ID                              | Name                                      | Issues |
|----------------------------------------|-------------------------------------------|--------|
| `116e85d1-e76a-4f88-a069-62db122e81f0` | Phase 1: Organizational Structure         | 6      |
| `ea38f859-f570-48a5-af6f-767819f57a61` | Phase 2: Mature RBAC                      | 5      |
| `4b18aeaa-e9ff-4e23-9767-75edfbf6efae` | Phase 3: SLA & Deadline Operations        | 5      |
| `6c5198cc-ff39-46f5-a014-3acdaa1cac9b` | Phase 4: Integrations & Exports           | 7      |
| `61323024-d1b9-4e0d-898f-7dc2cfe5d2f4` | Phase 5: Observability & Production Ops   | 5      |
| `a2320ada-9599-499f-81d8-108d9a810a1c` | Phase 6: Queue & Worker Architecture      | 4      |
| `4d66736b-9e49-442f-8551-10f6b0a0585f` | Phase 7: Enterprise & i18n                | 6      |

### Cycles (Sprints)

| Cycle ID                               | Dates              | Sprint                             |
|----------------------------------------|--------------------|------------------------------------|
| `3685b9c4-e713-43bf-a14f-8d86042843aa` | Apr 14 → Apr 28   | Sprint 1 (Phase 1: Schema + API)   |
| `a7466670-c7ac-471f-9081-bfc1dc1cfc7d` | Apr 28 → May 12   | Sprint 2 - Org UI and Tests        |
| `5ddcba37-29b1-49d5-b6ca-06acc95e2a24` | May 12 → May 26   | Sprint 3 - RBAC Schema and Engine  |
| `7a9a7a6c-b901-4e7f-a088-d9a46ccaf4d7` | May 26 → Jun 9    | Sprint 4 - RBAC UI and Tests       |
| `c87131eb-c04e-40c7-86fb-30beec6ff061` | Jun 9 → Jun 23    | Sprint 5 - SLA Engine and Schema   |
| `5deab0d6-287d-4eee-8ab1-dd3379668402` | Jun 23 → Jul 7    | Sprint 6 - SLA UI and Escalation   |
| `c0fe9145-f4c4-448e-b3eb-029e39a0bf63` | Jul 7 → Jul 21    | Sprint 7 - Export Engine + Webhooks|
| `40354359-340f-4472-96f6-3f2b1f2d744c` | Jul 21 → Aug 4    | Sprint 8 - Plugins                 |
| `ecc2b58f-70a3-4f7b-8a20-f302da7efeff` | Aug 4 → Aug 18    | Sprint 9 - Observability Stack     |
| `217f210d-0059-4f43-9f9c-d484ad0c2800` | Aug 18 → Sep 1    | Sprint 10 - Queue and Workers      |
| `7b0f484c-df2e-4509-9a98-08c15681e6a1` | Sep 1 → Sep 15    | Sprint 11 - SSO and SCIM           |
| `80a4744f-b256-462f-8d9a-391524eb542b` | Sep 15 → Sep 29   | Sprint 12 - i18n and Compliance    |

---

## API Endpoints

All paths relative to `http://plane.nexus.local/api/v1`. The workspace slug is `nous` and project ID is `6ea59a32-3d6a-4602-81bd-0df63db085a5` (abbreviated as `$PID` below).

### Read Operations

```bash
# List all work items (issues)
GET /workspaces/nous/projects/$PID/work-items/?per_page=100

# Get single work item
GET /workspaces/nous/projects/$PID/work-items/$ISSUE_ID/

# List states
GET /workspaces/nous/projects/$PID/states/

# List labels
GET /workspaces/nous/projects/$PID/labels/

# List modules
GET /workspaces/nous/projects/$PID/modules/

# List cycles
GET /workspaces/nous/projects/$PID/cycles/

# List issues in a cycle
GET /workspaces/nous/projects/$PID/cycles/$CYCLE_ID/cycle-issues/

# List members
GET /workspaces/nous/members/
```

### Write Operations

```bash
# Create work item
POST /workspaces/nous/projects/$PID/work-items/
{
  "name": "Title",
  "description_html": "<p>Description</p>",
  "priority": "high",       # urgent|high|medium|low|none
  "state": "$STATE_ID",
  "labels": ["$LABEL_ID"],
  "start_date": "2026-04-14",
  "target_date": "2026-04-28"
}

# Update work item (state, priority, assignees, etc.)
PATCH /workspaces/nous/projects/$PID/work-items/$ISSUE_ID/
{
  "state": "$NEW_STATE_ID",
  "priority": "medium"
}

# Add comment to work item
POST /workspaces/nous/projects/$PID/work-items/$ISSUE_ID/comments/
{
  "comment_html": "<p>Progress update...</p>"
}

# Assign issues to a cycle
POST /workspaces/nous/projects/$PID/cycles/$CYCLE_ID/cycle-issues/
{
  "issues": ["$ISSUE_ID_1", "$ISSUE_ID_2"]
}

# Create new label
POST /workspaces/nous/projects/$PID/labels/
{
  "name": "Label Name",
  "color": "#ff0000"
}
```

---

## Issue Map (All 42 Issues)

### Phase 1: Organizational Structure (Sprint 1-2)

| ID   | Issue UUID                             | Name                                  | Sprint |
|------|----------------------------------------|---------------------------------------|--------|
| PEV-1  | `873976fd-f510-4dda-b677-e6a99189e82f` | [EPIC] Phase 1: Org Structure       | 1      |
| PEV-2  | `f19dbc64-2409-49e0-afd9-491b2c4abff2` | Create departments/teams DB schema   | 1      |
| PEV-3  | `61a83235-1740-4dcb-9787-08fc74192721` | Implement departments API endpoints  | 1      |
| PEV-4  | `a9232a48-f4e0-4795-aefb-2b8caf57461a` | Department management UI pages       | 2      |
| PEV-5  | `650a7c6e-0ea5-4a4f-bf77-9961176e46d9` | Expand org chart to show departments | 2      |
| PEV-6  | `64ce7889-64a9-487c-8928-5aaf5700599b` | Tests for department model and API   | 2      |

### Phase 2: Mature RBAC (Sprint 3-4)

| ID   | Issue UUID                             | Name                                  | Sprint |
|------|----------------------------------------|---------------------------------------|--------|
| PEV-7  | `939a2fc0-ba00-456d-bf33-eee7e3296dcf` | [EPIC] Phase 2: Mature RBAC         | 3      |
| PEV-8  | `69517df1-f743-4bde-b612-ace18e75da1b` | Create roles/permission bundles schema| 3     |
| PEV-9  | `0bb16de4-7448-4ffa-9d66-250897bc3dd5` | Implement role evaluation engine     | 3      |
| PEV-10 | `673ba22f-b598-45f7-bde0-26ed6fdd3930` | RBAC admin UI                        | 4      |
| PEV-11 | `7d596fef-9262-4d23-9398-b02c7b758176` | RBAC integration tests               | 4      |

### Phase 3: SLA & Deadline Operations (Sprint 5-6)

| ID   | Issue UUID                             | Name                                  | Sprint |
|------|----------------------------------------|---------------------------------------|--------|
| PEV-12 | `f35695e7-375c-47df-a6e5-878144e1d80d` | [EPIC] Phase 3: SLA & Deadlines     | 5      |
| PEV-13 | `151ca076-23fe-4959-a567-a28317835f7e` | Add deadline and SLA fields          | 5      |
| PEV-14 | `8e3baf41-6cfe-442e-b8a7-d6597e33758e` | SLA evaluation engine                | 5      |
| PEV-15 | `067d219a-7bfb-447a-ba91-903c0b354e88` | SLA dashboard and deadline UI        | 6      |
| PEV-16 | `14b720f1-7c39-4f34-8038-c30d726ee84e` | Escalation policy config UI          | 6      |

### Phase 4: Integrations & Exports (Sprint 7-8)

| ID   | Issue UUID                             | Name                                  | Sprint |
|------|----------------------------------------|---------------------------------------|--------|
| PEV-17 | `fdb3dbbb-c88b-4fee-9581-883e0bdedb48` | [EPIC] Phase 4: Integrations        | 7      |
| PEV-18 | `8f428c3f-1b64-44ac-bd7f-733f30ee1629` | Excel/CSV/PDF export engine          | 7      |
| PEV-19 | `a33b8bd1-9e07-4a99-a7ba-526f66447c8f` | Export UI - download + scheduled     | 7      |
| PEV-20 | `5d20d339-bb1f-4653-b513-b41220361e36` | Outbound webhooks system             | 7      |
| PEV-21 | `67139907-ea1c-470f-9f7e-bed4bb3d2ec7` | Slack integration plugin             | 8      |
| PEV-22 | `48f15678-f72e-4adb-b722-b66dc9dfb978` | Email notification plugin (SMTP)     | 8      |
| PEV-23 | `88837ce8-268d-4ee6-bb8a-bc7d306bfaac` | Calendar sync plugin                 | 8      |
| PEV-24 | `522eec11-c913-448c-b75c-20e1e6f5c019` | Jira/Linear data import tool         | 8      |

### Phase 5: Observability (Sprint 9)

| ID   | Issue UUID                             | Name                                  | Sprint |
|------|----------------------------------------|---------------------------------------|--------|
| PEV-25 | `f9d4ae58-64fa-4f2e-8851-bfb5a3254f2b` | [EPIC] Phase 5: Observability        | 9      |
| PEV-26 | `e810772f-abc4-45e8-9abb-dec1b75da553` | Integrate OpenTelemetry SDK          | 9      |
| PEV-27 | `a33018e1-a394-487d-8e5e-d870d8ccb1f7` | Prometheus metrics endpoint          | 9      |
| PEV-28 | `56c5cfea-10eb-4b71-aadc-0278361da3fc` | Pre-built Grafana dashboards         | 9      |
| PEV-29 | `8cf1fbe5-6f8d-4c0e-820f-1f4af561df89` | Alerting rules + health checks       | 9      |

### Phase 6: Queue & Worker Architecture (Sprint 10)

| ID   | Issue UUID                             | Name                                  | Sprint |
|------|----------------------------------------|---------------------------------------|--------|
| PEV-30 | `bc6182b2-8944-4e9e-862b-a375ec33827b` | [EPIC] Phase 6: Queue Architecture   | 10     |
| PEV-31 | `38a57115-40cb-4368-a87f-4554a69ff61c` | Add Redis and BullMQ infrastructure  | 10     |
| PEV-32 | `b2770eaa-3574-4f63-85f6-ecdff4bfcafc` | Migrate scheduler to queue-based     | 10     |
| PEV-33 | `57358027-fe85-4246-9bed-92cc96d18a13` | Queue monitoring dashboard           | 10     |

### Phase 7: Enterprise & i18n (Sprint 11-12)

| ID   | Issue UUID                             | Name                                  | Sprint |
|------|----------------------------------------|---------------------------------------|--------|
| PEV-34 | `4a89c33d-d1f0-45c9-bff9-252c803d0ff9` | [EPIC] Phase 7: Enterprise           | 11     |
| PEV-35 | `286e84b0-1ab6-4e7f-8504-19a230e8600c` | SSO - SAML and OIDC                  | 11     |
| PEV-36 | `c30af652-a0fd-4665-8367-dfdae3151caf` | SCIM directory sync                  | 11     |
| PEV-37 | `c30c9716-50cc-426f-a6cc-ab258ebaaf8a` | Audit compliance export              | 12     |
| PEV-38 | `f76eae6c-7083-45d2-a71e-4127593ed63b` | Internationalization (i18n)          | 12     |
| PEV-39 | `673a9131-0542-47c3-a857-d0cd100d431d` | Customizable dashboards              | 12     |
| PEV-40 | `63de5518-b14a-40e6-ab0e-3843d156f3e4` | ESLint + Prettier CI                 | 12     |
| PEV-41 | `f2f80f3b-4a97-44ee-926b-bcf5173bcc51` | Test coverage reporting              | 12     |
| PEV-42 | `bb7daab1-8cb9-4ae2-803f-a585d6497176` | Global API rate limiting             | 12     |

---

## AI Agent Workflow

### Before Starting Work

1. **Check current sprint**: Find which cycle is active (compare dates with today)
2. **Read sprint issues**: `GET /cycles/$CYCLE_ID/cycle-issues/` to see what's planned
3. **Pick an issue**: Move it to "In Progress" state

```bash
# Move issue to In Progress
curl -X PATCH -H "X-Api-Key: $PLANE_API_KEY" -H "Content-Type: application/json" \
  "http://plane.nexus.local/api/v1/workspaces/nous/projects/$PID/work-items/$ISSUE_ID/" \
  -d '{"state": "<in-progress-state-id>"}'
```

### While Working

Post progress comments:

```bash
curl -X POST -H "X-Api-Key: $PLANE_API_KEY" -H "Content-Type: application/json" \
  "http://plane.nexus.local/api/v1/workspaces/nous/projects/$PID/work-items/$ISSUE_ID/comments/" \
  -d '{"comment_html": "<p>Implemented departments schema with 3 tables. Migration created. Running tests next.</p>"}'
```

### After Completing Work

1. Move issue to "Done" state
2. Add a completion comment with summary of changes
3. If the issue revealed new work, create a follow-up issue

```bash
# Mark done
curl -X PATCH -H "X-Api-Key: $PLANE_API_KEY" -H "Content-Type: application/json" \
  "http://plane.nexus.local/api/v1/workspaces/nous/projects/$PID/work-items/$ISSUE_ID/" \
  -d '{"state": "<done-state-id>"}'

# Create follow-up if needed
curl -X POST -H "X-Api-Key: $PLANE_API_KEY" -H "Content-Type: application/json" \
  "http://plane.nexus.local/api/v1/workspaces/nous/projects/$PID/work-items/" \
  -d '{
    "name": "[Follow-up] Additional migration for department constraints",
    "description_html": "<p>Discovered during PEV-2 that we need additional FK constraints.</p>",
    "priority": "medium",
    "labels": ["beeb8f83-0c9d-4f4c-8456-67b6131ca60e"]
  }'
```

### Reading the Full Board

```bash
# Get everything in one pass
PID="6ea59a32-3d6a-4602-81bd-0df63db085a5"

# All issues with state info
curl -H "X-Api-Key: $PLANE_API_KEY" \
  "http://plane.nexus.local/api/v1/workspaces/nous/projects/$PID/work-items/?per_page=100"

# Summary by module
for MODULE_ID in 116e85d1-e76a-4f88-a069-62db122e81f0 ea38f859-f570-48a5-af6f-767819f57a61 \
  4b18aeaa-e9ff-4e23-9767-75edfbf6efae 6c5198cc-ff39-46f5-a014-3acdaa1cac9b \
  61323024-d1b9-4e0d-898f-7dc2cfe5d2f4 a2320ada-9599-499f-81d8-108d9a810a1c \
  4d66736b-9e49-442f-8551-10f6b0a0585f; do
  curl -s -H "X-Api-Key: $PLANE_API_KEY" \
    "http://plane.nexus.local/api/v1/workspaces/nous/projects/$PID/modules/$MODULE_ID/"
done
```

---

## Advanced Operations

### Sub-issues (Parent-Child)

All EPICs have sub-issues linked via `parent` field. To set a parent:

```bash
curl -X PATCH -H "X-Api-Key: $PLANE_API_KEY" -H "Content-Type: application/json" \
  "$BASE/work-items/$CHILD_ID/" \
  -d '{"parent": "$PARENT_EPIC_ID"}'
```

### Relations (Dependencies)

Issues have blocking/blocked_by relations. Relation types: `blocking`, `blocked_by`, `duplicate`, `relates_to`, `start_before`, `start_after`, `finish_before`, `finish_after`.

```bash
# Read relations
curl -H "X-Api-Key: $PLANE_API_KEY" \
  "$BASE/work-items/$ISSUE_ID/relations/"

# Create a relation
curl -X POST -H "X-Api-Key: $PLANE_API_KEY" -H "Content-Type: application/json" \
  "$BASE/work-items/$ISSUE_ID/relations/" \
  -d '{"relation_type":"blocked_by","issues":["$BLOCKING_ISSUE_ID"]}'
```

Current dependency chain:
- Phase 2 (RBAC) blocked_by Phase 1 (Org Structure)
- Phase 3 (SLA) blocked_by Phase 2 (RBAC)
- Phase 4 (Integrations) blocked_by Phase 3 (SLA)
- Phase 6 (Queue) blocked_by Phase 5 (Observability)
- Within phases: Schema → API → UI → Tests

### Links (External References)

Attach links to code, docs, or external resources:

```bash
# Add link
curl -X POST -H "X-Api-Key: $PLANE_API_KEY" -H "Content-Type: application/json" \
  "$BASE/work-items/$ISSUE_ID/links/" \
  -d '{"title":"Relevant source file","url":"https://github.com/..."}'

# List links
curl -H "X-Api-Key: $PLANE_API_KEY" "$BASE/work-items/$ISSUE_ID/links/"
```

### Activities (Audit Trail)

Read the full activity log for any issue:

```bash
curl -H "X-Api-Key: $PLANE_API_KEY" "$BASE/work-items/$ISSUE_ID/activities/"
```

### Search

Search across all work items:

```bash
curl -H "X-Api-Key: $PLANE_API_KEY" \
  "http://plane.nexus.local/api/v1/workspaces/nous/work-items/search/?search=SLA&project_id=$PID"
```

---

## Conventions

1. **EPIC issues** are prefixed with `[EPIC]` and use the `Epic` label. They represent phase-level goals.
2. **Sub-issues** under an EPIC are the actual implementation tasks.
3. **Priorities**: `urgent` = blocks everything, `high` = current sprint must-have, `medium` = should-have, `low` = nice-to-have.
4. **Comments** should use HTML format (`comment_html`). Keep them concise but informative.
5. **State transitions**: Backlog → Todo → In Progress → Done. Use Cancelled for abandoned work.
6. **Labels** describe the nature of work (Feature, Security, Plugin, etc.), not the phase.
7. **Modules** = phases (long-lived feature groups). **Cycles** = sprints (time-boxed delivery windows).

## Rate Limits

The Plane API has rate limiting: 60 requests/minute per API key (header `X-Ratelimit-Remaining` shows remaining quota).

## Gotchas

- The v1 API uses `/work-items/` not `/issues/` (Plane recently renamed issues to work items)
- The old `/issues/` path still works (backward compat) but prefer `/work-items/`
- State IDs must be queried first — they are project-specific UUIDs
- Cycle dates use ISO format with time component (e.g., `2026-04-14T00:00:01Z`)
- The `description_html` field requires HTML, not plain text or Markdown
- Module issues and cycle issues are managed through separate join endpoints
- `estimate_point` field requires project estimate system configured via UI first (not available in v1 API)
- Webhooks, Pages, Views, and Notifications are only on the internal `/api/` path (session auth, not API key)
- The auth header is `X-Api-Key` (camelCase), not `X-API-Key` — Django normalizes case but the middleware defines it as `X-Api-Key`

## Features Used in This Project

| Feature | Count | Status |
|---------|-------|--------|
| Modules (Phases) | 7 | All with descriptions + date ranges |
| Cycles (Sprints) | 12 | Bi-weekly, Apr 14 → Sep 29 |
| Work Items | 42 | All with descriptions, priorities, labels, dates, assignees |
| Sub-issues | 35 | All tasks linked to their EPIC parent |
| Relations | 10 | Cross-phase + intra-phase blocking dependencies |
| Labels | 10 | Feature, Epic, Security, Infra, Integration, Plugin, AI-Gateway, Docs, Tech Debt, UX/UI |
| Links | 12 | Code/doc references on all EPICs |
| Comments | 7 | Audit context on all EPICs |
| States | 5 | Backlog, Todo, In Progress, Done, Cancelled |
