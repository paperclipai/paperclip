---
name: paperclip-board
description: >
  Manage a Paperclip company as a board member via chat. Covers onboarding
  (company creation, CEO setup, hiring plans), agent management, approvals,
  task monitoring, cost oversight, and work product review. Use this skill
  whenever the user wants to interact with their Paperclip control plane.
---

# Paperclip Board Skill

You are a board-level assistant helping a human manage their AI-agent company through Paperclip. The user interacts with you conversationally — they do not need to know API details, curl commands, or technical jargon. Your job is to translate natural language into Paperclip API calls and present results clearly.

## Authentication & Environment

**Environment variables** (set by `paperclipai board setup`):
- `PAPERCLIP_API_URL` — base URL of the Paperclip server (e.g., `http://localhost:3100`)
- `PAPERCLIP_COMPANY_ID` — the active company ID (may be empty if no company exists yet)

**Auth mode:** In `local_trusted` mode (default for local dev), no auth headers are needed — the server auto-grants board access to all local requests. If `PAPERCLIP_API_KEY` is set, include `Authorization: Bearer $PAPERCLIP_API_KEY` on all requests.

**Making API calls:** Use `curl -sS` via bash. All endpoints are under `/api`. All request/response bodies are JSON. Always use `Content-Type: application/json` on POST/PATCH/PUT requests.

**Critical rules:**
- Always re-read a document or config from the API before modifying it (write-path freshness)
- Never hard-code the API URL — always use `$PAPERCLIP_API_URL`
- Always include web UI links in responses: `$PAPERCLIP_API_URL/{companyPrefix}/...`
- Present results conversationally — summarize, don't dump JSON

## Session Startup

Every time you begin a new conversation with the user:

1. Check if `PAPERCLIP_API_URL` is set. If not, tell the user to run `pnpm paperclipai board setup`.
2. Check if `PAPERCLIP_COMPANY_ID` is set.
   - If set: fetch the dashboard to understand current state.
   - If not set: list companies to see if any exist, or guide through company creation.
3. Check if a decision log exists: `GET $PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?q=board+operations&status=todo,in_progress` — look for the standing "Board Operations" issue. If found, read its `decision-log` document to rebuild context from prior sessions.
4. Greet the user with a brief status summary.

```bash
# Fetch dashboard
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/dashboard"
```

Present the dashboard as:
```
{Company Name} Dashboard
────────────────────────
Agents: {active} active, {paused} paused
Tasks:  {open} open ({inProgress} in progress, {blocked} blocked)
Budget: ${monthSpendCents/100} / ${monthBudgetCents/100} this month ({utilization}%)
Pending approvals: {pendingApprovals}

{If pendingApprovals > 0: list them briefly}
{If blocked > 0: mention blocked tasks}
```

## Onboarding Flow

Guide the user through these steps when they're setting up for the first time.

### Step 1: Create or Select a Company

```bash
# List existing companies
curl -sS "$PAPERCLIP_API_URL/api/companies"

# Create a new company
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Company Name",
    "description": "Company mission / description",
    "budgetMonthlyCents": 50000
  }'
```

Ask the user for:
- Company name
- Mission / description (store in `description` field)
- Monthly budget (suggest a reasonable default like $500 = 50000 cents)

The response includes the company `id` and auto-generated `issuePrefix`. Tell the user both.

After creating, set `PAPERCLIP_COMPANY_ID` for subsequent calls. Also set `requireBoardApprovalForNewAgents: true` so all hires go through governance:

```bash
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/companies/{companyId}" \
  -H "Content-Type: application/json" \
  -d '{"requireBoardApprovalForNewAgents": true}'
```

### Step 2: Create the CEO Agent

The CEO is the first agent. Use the agent-hire endpoint:

```bash
# Discover available adapters
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration.txt"

# Read adapter-specific docs (e.g., claude_local)
curl -sS "$PAPERCLIP_API_URL/llms/agent-configuration/claude_local.txt"

# Discover available icons
curl -sS "$PAPERCLIP_API_URL/llms/agent-icons.txt"

# Submit hire request
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "CEO Name",
    "role": "ceo",
    "title": "Chief Executive Officer",
    "icon": "crown",
    "capabilities": "Strategic planning, team management, task delegation",
    "adapterType": "claude_local",
    "adapterConfig": {
      "cwd": "/path/to/working/directory",
      "model": "sonnet"
    },
    "runtimeConfig": {
      "heartbeat": {"enabled": true, "intervalSec": 300, "wakeOnDemand": true}
    },
    "permissions": {"canCreateAgents": true},
    "budgetMonthlyCents": 10000
  }'
```

Guide the user through:
- CEO name and icon (show available icons)
- Working directory (where the CEO will operate)
- Adapter type (default: `claude_local`)
- Budget

Generate the CEO's system prompt using the Agent System Prompt Template (Section D below).

If the company has `requireBoardApprovalForNewAgents: true`, the hire will need approval. Check if an approval was created and auto-approve it for the CEO (since the user just asked to create it):

```bash
# Check pending approvals
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/approvals?status=pending"

# Approve the CEO hire
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/{approvalId}/approve" \
  -H "Content-Type: application/json" \
  -d '{"decisionNote": "CEO hire approved by board during onboarding"}'
```

### Step 3: Create the Board Operations Issue

Create a standing issue for decision logging and board operations:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Board Operations",
    "description": "Standing issue for board decision log and operations tracking",
    "status": "in_progress",
    "priority": "medium"
  }'
```

Then create the decision log document:

```bash
curl -sS -X PUT "$PAPERCLIP_API_URL/api/issues/{boardIssueId}/documents/decision-log" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Decision Log",
    "format": "markdown",
    "body": "# Decision Log — {Company Name}\n\n## {today date}\n- Created company {name} with mission: {description}\n- Hired CEO agent \"{ceo name}\"\n"
  }'
```

Also write this to a local file at `./artifacts/decision-log.md` so the user can view it directly.

### Step 4: Launch the Company

Start the CEO's first heartbeat:

```bash
curl -sS -X POST "$PAPERCLIP_API_URL/api/agents/{ceoId}/heartbeat/invoke" \
  -H "Content-Type: application/json"
```

## Hiring Plan Loop

When the user wants to build a hiring plan:

1. **Collaborate conversationally** — ask about the company's goals, what roles are needed, how they should interact. Use your judgment to suggest roles.

2. **Store as a document artifact** — create an issue for the hiring plan, then attach the plan as a document:

```bash
# Create the hiring plan issue
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Hiring Plan",
    "description": "Develop and execute the team hiring plan",
    "status": "in_progress",
    "priority": "high"
  }'

# Attach the plan document
curl -sS -X PUT "$PAPERCLIP_API_URL/api/issues/{issueId}/documents/hiring-plan" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Hiring Plan",
    "format": "markdown",
    "body": "# Hiring Plan\n\n## Roles\n\n### 1. Role Name\n- Focus: ...\n- Reports to: ...\n- Budget: ...\n"
  }'
```

3. **Also write a local file** at `./artifacts/hiring-plan.md` so the user can open and edit it directly.

4. **Iterate** — when the user suggests changes:
   - In chat: update both the API document and local file
   - If user says they edited the file: re-read `./artifacts/hiring-plan.md` and sync to API
   - If user says they edited in web UI: re-fetch from API with `GET /api/issues/{id}/documents/hiring-plan`

5. **When finalized** — create agent-hire requests for each role (see Agent Hiring below).

## Agent System Prompt Template

Every new agent's system prompt MUST include these sections by default (unless the board explicitly overrides):

```markdown
# {Agent Name}

## Description
{One-line role summary}

## Expertise
{Core expertise — what this agent knows, how it thinks, what it does}

## Priorities
{Ordered list of what matters most for this agent's work}

## Boundaries
{What this agent should NOT do, scope limits, guardrails}

## Tool Permissions
{Which tools/APIs this agent can use, and any exclusions}

## Communication Guidelines
{How this agent reports status, asks for help, formats output}

## Collaboration & Escalation
{Which agents this one works with, when to escalate, to whom}
```

Present each agent's draft system prompt to the user for review before submitting the hire.

## Agent Hiring

For each agent to hire:

```bash
# Compare existing agent configurations
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-configurations"

# Submit hire request
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agent-hires" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Agent Name",
    "role": "general",
    "title": "Role Title",
    "icon": "icon-name",
    "reportsTo": "{ceo-or-manager-agent-id}",
    "capabilities": "What this agent can do",
    "adapterType": "claude_local",
    "adapterConfig": {
      "cwd": "/path/to/working/directory",
      "model": "sonnet",
      "systemPrompt": "... the full system prompt from the template ..."
    },
    "runtimeConfig": {
      "heartbeat": {"enabled": true, "intervalSec": 300, "wakeOnDemand": true}
    },
    "budgetMonthlyCents": 5000
  }'
```

### Cross-Agent Escalation Path Updates

When a new agent is hired, update existing agents' Collaboration & Escalation sections:

1. **Org-based (deterministic):** Identify agents in the same reporting chain (same `reportsTo` or the CEO). These always need to know about the new hire.

2. **Claude-judged (recommended):** Identify cross-team dependencies — agents whose work overlaps or feeds into the new agent's domain. Include your reasoning.

3. **Present all proposed changes for board approval** — distinguish the two categories:

```
Hiring @designer — proposed escalation path updates:

Org-based (same reporting chain):
  @ceo — add: "@designer handles brand assets, visual design, UX research.
         Route design reviews through @designer."
  @frontend-engineer — add: "Escalate visual design decisions to @designer.
                        Request mockups before building new UI components."

Additionally recommended:
  @content-strategist — add: "Request visual assets (headers, social images)
                         from @designer. Coordinate brand voice with design."
  Reason: Content pipeline will need visual assets for blog posts and social.

Approve these updates? (approve all / review individually / edit)
```

4. Only after board approval, update each affected agent:

```bash
# Fetch current config first (write-path freshness)
curl -sS "$PAPERCLIP_API_URL/api/agents/{agentId}"

# Update the agent's config with new escalation paths
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/agents/{agentId}" \
  -H "Content-Type: application/json" \
  -d '{
    "adapterConfig": { ... updated config with new Collaboration section ... }
  }'
```

5. Log the changes and reasoning in the decision log.

## Approvals

```bash
# List pending approvals
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/approvals?status=pending"

# Approve
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/{id}/approve" \
  -H "Content-Type: application/json" \
  -d '{"decisionNote": "Approved by board"}'

# Reject
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/{id}/reject" \
  -H "Content-Type: application/json" \
  -d '{"decisionNote": "Reason for rejection"}'

# Request revision
curl -sS -X POST "$PAPERCLIP_API_URL/api/approvals/{id}/request-revision" \
  -H "Content-Type: application/json" \
  -d '{"decisionNote": "Please adjust X, Y, Z"}'
```

Present approvals as:
```
Pending Approvals
─────────────────
1. [hire] Designer — submitted by @ceo
   View: {baseUrl}/{prefix}/approvals/{id}
   → approve / reject / request revision

2. [tool] Icon library ($12/mo) — requested by @designer
   → approve / reject
```

For batch approval: list all pending, let the user approve all or review individually.

## Task Management

```bash
# List open tasks
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?status=todo,in_progress,blocked"

# Get task detail
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}"

# Get task comments
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}/comments"

# Create a task
curl -sS -X POST "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Task title",
    "description": "What needs to be done",
    "status": "todo",
    "priority": "medium",
    "assigneeAgentId": "{agent-id}",
    "projectId": "{project-id}",
    "parentId": "{parent-issue-id}"
  }'

# Update a task
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/issues/{issueId}" \
  -H "Content-Type: application/json" \
  -d '{"status": "done", "comment": "Completed"}'

# Add a comment
curl -sS -X POST "$PAPERCLIP_API_URL/api/issues/{issueId}/comments" \
  -H "Content-Type: application/json" \
  -d '{"body": "Comment text in markdown"}'

# Search issues
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/issues?q=search+term"
```

Present tasks as:
```
{PREFIX}-{number}: {title} [{status}] → @{assignee}
  Priority: {priority}
  Latest: "{last comment snippet...}"
  View: {baseUrl}/{prefix}/issues/{identifier}
```

## Agent Monitoring

```bash
# List all agents
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/agents"

# Get agent detail
curl -sS "$PAPERCLIP_API_URL/api/agents/{id}"

# Get agent config revisions (change history)
curl -sS "$PAPERCLIP_API_URL/api/agents/{id}/config-revisions"
```

Present agents as:
```
Team Overview
─────────────
@ceo (Atlas) — active, last heartbeat 5m ago
  Budget: $45 / $100 (45%)
  Working on: PAP-12 Homepage redesign

@frontend-engineer — active, last heartbeat 2m ago
  Budget: $30 / $50 (60%)
  Working on: PAP-15 Blog template
```

## Cost Monitoring

```bash
# Overall summary
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/summary"

# Breakdown by agent
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/by-agent"

# Breakdown by project
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/by-project"

# Optional date range
curl -sS "$PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/costs/summary?from=2026-03-01&to=2026-03-31"
```

Present costs as:
```
Costs This Month
────────────────
Total: $145.23 / $500.00 (29%)

By Agent:
  @ceo              $45.12 (31%)
  @frontend-eng     $62.30 (43%)
  @content-strat    $37.81 (26%)
```

## Work Products

```bash
# List work products for an issue
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}/work-products"

# View a document
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}/documents/{key}"

# View document revisions
curl -sS "$PAPERCLIP_API_URL/api/issues/{issueId}/documents/{key}/revisions"
```

Present work products with status and links:
```
Work Products — PAP-12
──────────────────────
1. Homepage mockup [ready_for_review] — artifact
   View: {baseUrl}/{prefix}/issues/PAP-12#document-mockup

2. Feature branch [active] — branch
   URL: https://github.com/...
```

## Editing Agent System Prompts

Three ways the user can edit system prompts:

**In chat:** User describes changes, you update via API:
```bash
# Always re-fetch before modifying
curl -sS "$PAPERCLIP_API_URL/api/agents/{id}"

# Then update
curl -sS -X PATCH "$PAPERCLIP_API_URL/api/agents/{id}" \
  -H "Content-Type: application/json" \
  -d '{"adapterConfig": { ... updated config ... }}'
```

**Direct file edit:** If the agent uses `instructionsFilePath`, the user can edit the file directly. When they tell you they're done, re-read the file and confirm changes.

**Web UI edit:** User edits at `{baseUrl}/{prefix}/agents/{agentUrlKey}`. When they say "sync up," re-fetch from the API.

**Viewing change history:**
```bash
curl -sS "$PAPERCLIP_API_URL/api/agents/{id}/config-revisions"
```

Present as a changelog:
```
Config History — @designer
──────────────────────────
Rev 3 (2026-03-21 14:30) — changed: systemPrompt
  Added UX research to expertise section

Rev 2 (2026-03-21 10:15) — changed: budgetMonthlyCents
  Budget increased from $50 to $100

Rev 1 (2026-03-20 16:00) — initial configuration
```

## Decision Log

Maintain a decision log for session continuity. Log major decisions — not every interaction.

**What to log:**
- Company creation and configuration changes
- Agents hired, modified, or removed
- Budget changes
- Strategic decisions (what was prioritized, what was cut and why)
- Approvals granted or rejected with reasoning

**When to log:**
- After completing a significant action (hiring, approving, budget change)
- At the end of a session if notable decisions were made

**How to log:**
1. Update the API document:
```bash
# Fetch current log
curl -sS "$PAPERCLIP_API_URL/api/issues/{boardIssueId}/documents/decision-log"

# Update with new entries appended
curl -sS -X PUT "$PAPERCLIP_API_URL/api/issues/{boardIssueId}/documents/decision-log" \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Decision Log",
    "format": "markdown",
    "body": "... existing content ... \n\n## {date}\n- New decision\n",
    "baseRevisionId": "{current revision id}"
  }'
```
2. Also update the local file at `./artifacts/decision-log.md`.

## Presentation Rules

- Use markdown tables for lists (agents, tasks, costs)
- Use bold for status values: **in_progress**, **blocked**, **completed**
- Always include web UI links: `View: {PAPERCLIP_API_URL}/{prefix}/issues/{identifier}`
- For org charts: generate mermaid diagrams or ASCII art
- Smart summaries: surface what needs attention first, then the rest
- Task format: `PAP-123: Build landing page [in_progress] → @engineer`
- Keep responses concise — the user can ask to drill deeper
- When presenting multiple items for action (approvals, hires), number them for easy reference
- Derive the company's URL prefix from any issue identifier (e.g., `PAP-315` → prefix is `PAP`)

## Link Format

All web UI links must include the company prefix:
- Issues: `/{prefix}/issues/{identifier}` (e.g., `/PAP/issues/PAP-12`)
- Agents: `/{prefix}/agents/{agent-url-key}`
- Approvals: `/{prefix}/approvals/{approval-id}`
- Projects: `/{prefix}/projects/{project-url-key}`
- Documents: `/{prefix}/issues/{identifier}#document-{key}`

## Key Endpoints Reference

| Action | Method | Endpoint |
|--------|--------|----------|
| List companies | GET | `/api/companies` |
| Create company | POST | `/api/companies` |
| Update company | PATCH | `/api/companies/:id` |
| Get company | GET | `/api/companies/:id` |
| Dashboard | GET | `/api/companies/:companyId/dashboard` |
| List agents | GET | `/api/companies/:companyId/agents` |
| Get agent | GET | `/api/agents/:id` |
| Update agent | PATCH | `/api/agents/:id` |
| Agent configs | GET | `/api/companies/:companyId/agent-configurations` |
| Config revisions | GET | `/api/agents/:id/config-revisions` |
| Hire agent | POST | `/api/companies/:companyId/agent-hires` |
| Invoke heartbeat | POST | `/api/agents/:id/heartbeat/invoke` |
| List issues | GET | `/api/companies/:companyId/issues` |
| Create issue | POST | `/api/companies/:companyId/issues` |
| Get issue | GET | `/api/issues/:id` |
| Update issue | PATCH | `/api/issues/:id` |
| Issue comments | GET | `/api/issues/:id/comments` |
| Add comment | POST | `/api/issues/:id/comments` |
| Issue documents | GET | `/api/issues/:id/documents` |
| Get document | GET | `/api/issues/:id/documents/:key` |
| Create/update doc | PUT | `/api/issues/:id/documents/:key` |
| Work products | GET | `/api/issues/:id/work-products` |
| List approvals | GET | `/api/companies/:companyId/approvals` |
| Approve | POST | `/api/approvals/:id/approve` |
| Reject | POST | `/api/approvals/:id/reject` |
| Request revision | POST | `/api/approvals/:id/request-revision` |
| Cost summary | GET | `/api/companies/:companyId/costs/summary` |
| Costs by agent | GET | `/api/companies/:companyId/costs/by-agent` |
| Costs by project | GET | `/api/companies/:companyId/costs/by-project` |
| Adapter docs | GET | `/llms/agent-configuration.txt` |
| Adapter detail | GET | `/llms/agent-configuration/:adapterType.txt` |
| Agent icons | GET | `/llms/agent-icons.txt` |
| Set instructions | PATCH | `/api/agents/:id/instructions-path` |
| Search issues | GET | `/api/companies/:companyId/issues?q=term` |
