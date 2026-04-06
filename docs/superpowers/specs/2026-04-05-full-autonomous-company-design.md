# Full Autonomous Company Design

**Date:** 2026-04-05
**Status:** Approved
**Author:** Claude (with user approval)

## Overview

When a new company is created in OH MY COMPANY, it should immediately become operational with a CEO agent, smart issue routing, approval gates, real-time notifications, agent messaging, skill discovery, and auto-recovery. This eliminates all manual setup steps after company creation.

## User-Approved Parameters

- **Approval gates on:** spending >$5/task, strategy decisions, agent termination
- **CEO model:** Configurable per company, default Sonnet
- **Agent communication:** Both real-time notifications AND direct messaging

---

## System 1: Auto-Company Bootstrap

### Goal
When a company is created via `POST /companies`, automatically create and start a CEO agent.

### Implementation
- **Hook location:** `server/src/routes/companies.ts` — after `svc.create()` returns
- **CEO agent config:**
  - `name`: "CEO"
  - `role`: "ceo"
  - `adapterType`: company's configured adapter (default `claude_local`)
  - `adapterConfig.model`: company's configured model (default `sonnet`)
  - `status`: "idle" (heartbeat timer will activate it)
  - `canCreateAgents`: true
  - `budgetMonthlyCents`: inherit from company or default 500 ($5)
- **Auto-wakeup:** After CEO creation, invoke `heartbeat.wakeup(ceoAgent.id)` with source `automation` and reason `company_bootstrap`
- **CEO bootstrap instructions:** Include system prompt instructing CEO to:
  1. Review company name and context
  2. Create initial org structure (propose hiring plan)
  3. Submit hiring proposals for user approval (via approval gate)

### Database Changes
- Add `autoBootstrapCeo` boolean to companies table (default true)
- Add `defaultCeoModel` text to companies table (default "sonnet")

### Files to Modify
- `packages/db/src/schema/companies.ts` — add columns
- `packages/shared/src/types/` — update company types
- `server/src/routes/companies.ts` — add bootstrap logic after create
- `server/src/services/agents.ts` — add `createCeoForCompany()` helper

---

## System 2: Real-Time Agent Notifications

### Goal
Agents wake instantly when mentioned, assigned issues, or need to respond to approvals — not just on heartbeat timer.

### Implementation
- **Extend existing wakeup system** in `server/src/services/heartbeat.ts`
- **New wakeup sources:**
  - `mention` — agent @mentioned in issue comment or message
  - `approval_response` — admin approved/rejected a pending gate
  - `skill_available` — new skill registered matching agent capabilities
- **Notification triggers (add hooks in):**
  - `server/src/routes/issues.ts` — on comment creation, scan for @agent mentions
  - `server/src/routes/agents.ts` — on approval response, wake requesting agent
  - Issue status changes — wake assigned agent

### Mention Detection
```typescript
function extractAgentMentions(text: string, companyAgents: Agent[]): string[] {
  const mentions: string[] = [];
  for (const agent of companyAgents) {
    if (text.includes(`@${agent.name}`)) mentions.push(agent.id);
  }
  return mentions;
}
```

### Files to Modify
- `server/src/services/heartbeat.ts` — add new wakeup sources to enum
- `server/src/services/issue-assignment-wakeup.ts` — extend with mention detection
- `packages/db/src/schema/agent_wakeup_requests.ts` — add new source values
- `packages/shared/src/types/` — update wakeup source types

---

## System 3: Approval Gates

### Goal
Certain agent actions require human approval before execution: spending >$5/task, strategy decisions, agent termination.

### Implementation

#### New Database Table: `approval_gates`
```sql
CREATE TABLE approval_gates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  gate_type TEXT NOT NULL, -- 'spending' | 'strategy' | 'termination'
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'rejected'
  request_payload JSONB NOT NULL,
  response_payload JSONB,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  responded_by TEXT, -- user ID who approved/rejected
  threshold_amount_cents INTEGER, -- for spending gates
  actual_amount_cents INTEGER, -- for spending gates
  expires_at TIMESTAMPTZ
);
```

#### Gate Types
1. **Spending gate** — triggered when agent's task cost estimate > 500 cents ($5)
   - Agent submits cost estimate before execution
   - Gate blocks until admin approves
   - On approval, agent proceeds; on rejection, agent skips task
2. **Strategy gate** — triggered when CEO proposes org changes (hiring, restructuring)
   - CEO submits proposal as gate request
   - Admin reviews and approves/rejects
3. **Termination gate** — triggered when any agent requests to terminate another agent
   - Requesting agent submits termination request
   - Admin must approve before termination executes

#### API Routes
- `POST /companies/:companyId/approval-gates` — create gate (agent-facing)
- `GET /companies/:companyId/approval-gates` — list gates (admin UI)
- `PATCH /companies/:companyId/approval-gates/:id` — approve/reject (admin-facing)

#### Agent Integration
- Agents check gates before executing gated actions
- Heartbeat context includes pending gate status
- On gate response, agent receives wakeup with `approval_response` source

### Files to Create
- `packages/db/src/schema/approval_gates.ts`
- `server/src/services/approval-gates.ts`
- `server/src/routes/approval-gates.ts`
- `ui/src/pages/ApprovalGates.tsx` — admin approval queue UI

### Files to Modify
- `packages/db/src/schema/index.ts` — export new table
- `server/src/routes/index.ts` — mount new router
- `ui/src/App.tsx` — add approval gates route
- `server/src/services/heartbeat.ts` — include gate status in agent context

---

## System 4: Smart Issue Routing

### Goal
When issues are created without an assignee, automatically route them to the best-fit agent based on capabilities, current load, and org structure.

### Implementation

#### Routing Algorithm
1. **Capability match:** Score agents by keyword overlap between issue title/description and agent capabilities/role
2. **Load balance:** Prefer agents with fewer active issues (weighted by priority)
3. **Org hierarchy:** Route to the lowest-level agent that can handle the issue; escalate to manager if no match
4. **CEO fallback:** If no suitable agent found, assign to CEO for delegation

#### Auto-Assignment Hook
- Location: `server/src/routes/issues.ts` — after issue creation when `assigneeAgentId` is null
- Call `routeIssue(companyId, issue)` to find best agent
- Auto-assign and trigger wakeup

#### Service
```typescript
// server/src/services/issue-router.ts
export async function routeIssue(companyId: string, issue: Issue): Promise<string | null> {
  const agents = await getActiveAgents(companyId);
  const scored = agents.map(agent => ({
    agent,
    score: computeCapabilityScore(agent, issue) * 0.6 +
           computeLoadScore(agent) * 0.3 +
           computeHierarchyScore(agent, issue) * 0.1
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.agent.id ?? getCeoAgentId(companyId);
}
```

### Files to Create
- `server/src/services/issue-router.ts`

### Files to Modify
- `server/src/routes/issues.ts` — add auto-routing after issue creation
- `server/src/services/agents.ts` — add `getActiveAgentsByCompany()` helper

---

## System 5: Agent Direct Messaging

### Goal
Agents can send messages directly to other agents (point-to-point) or broadcast to their team. Messages trigger instant wakeup.

### Implementation

#### New Database Table: `agent_messages`
```sql
CREATE TABLE agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  from_agent_id UUID NOT NULL REFERENCES agents(id),
  to_agent_id UUID REFERENCES agents(id), -- NULL for broadcast
  broadcast_scope TEXT, -- 'team' | 'company' | NULL
  message_type TEXT NOT NULL, -- 'task_delegation' | 'status_update' | 'question' | 'escalation' | 'general'
  subject TEXT,
  body TEXT NOT NULL,
  metadata JSONB,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

#### Message Types
- `task_delegation` — CEO/manager delegating work to report
- `status_update` — agent reporting progress to manager
- `question` — agent asking another agent for help
- `escalation` — agent escalating issue to manager
- `general` — freeform communication

#### API Routes
- `POST /companies/:companyId/agent-messages` — send message
- `GET /companies/:companyId/agent-messages` — list messages (filtered by agent)
- `PATCH /companies/:companyId/agent-messages/:id/read` — mark read

#### Wakeup Integration
- On message send, trigger `heartbeat.wakeup(toAgentId, { source: 'message' })`
- For broadcasts, wake all agents in scope
- Agent heartbeat context includes unread message count

### Files to Create
- `packages/db/src/schema/agent_messages.ts`
- `server/src/services/agent-messages.ts`
- `server/src/routes/agent-messages.ts`
- `ui/src/components/AgentMessages.tsx` — message viewer in UI

### Files to Modify
- `packages/db/src/schema/index.ts` — export new table
- `server/src/routes/index.ts` — mount new router
- `server/src/services/heartbeat.ts` — add message source, include unread count in context

---

## System 6: Skill Discovery & Auto-Learning

### Goal
Agents can discover, request, and auto-learn skills based on their role and task needs.

### Implementation

#### Skill Registry Enhancement
- Extend existing skill system with a searchable registry
- Skills tagged with `requiredForRoles` (e.g., ["ceo", "developer", "designer"])
- On agent creation, auto-assign skills matching their role

#### New Database Table: `agent_skill_requests`
```sql
CREATE TABLE agent_skill_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id),
  agent_id UUID NOT NULL REFERENCES agents(id),
  skill_name TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'denied' | 'auto_approved'
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);
```

#### Auto-Assignment Logic
- When agent is created with role X, query skill registry for skills with `requiredForRoles` including X
- Auto-assign matching skills to agent's instruction bundle
- Agent can request additional skills during execution; auto-approve if skill is in the "safe" list

#### Skill Discovery During Execution
- Agent heartbeat context includes available (unassigned) skills
- Agent can issue `request_skill` action in its response
- Skills marked `autoApprove: true` are granted immediately
- Others go through approval gate

### Files to Create
- `packages/db/src/schema/agent_skill_requests.ts`
- `server/src/services/skill-discovery.ts`

### Files to Modify
- `server/src/services/agents.ts` — auto-assign skills on creation
- `server/src/services/heartbeat.ts` — include available skills in context
- `packages/db/src/schema/index.ts` — export new table

---

## System 7: Auto-Recovery

### Goal
Agents automatically recover from failures with retry, reassignment, and escalation.

### Implementation

#### Retry with Backoff
- On heartbeat run failure, auto-retry up to 3 times with exponential backoff (5s, 30s, 120s)
- Track retry count in `heartbeat_runs` table

#### Reassignment
- After 3 failed retries, reassign issue to another capable agent
- Use issue router (System 4) to find alternative agent

#### Escalation
- If no alternative agent available, escalate to manager/CEO
- Create escalation message (System 5) with failure context

#### Stale Lock Cleanup
- Periodic timer checks for heartbeat runs stuck in `running` for >10 minutes
- Cancel stale runs and requeue wakeup

#### Database Changes
- Add `retryCount` integer to `heartbeat_runs` (default 0)
- Add `maxRetries` integer to `heartbeat_runs` (default 3)
- Add `nextRetryAt` timestamptz to `heartbeat_runs`

### Files to Modify
- `packages/db/src/schema/heartbeat_runs.ts` — add retry columns
- `server/src/services/heartbeat.ts` — add retry logic, stale cleanup
- `server/src/services/issue-router.ts` — add reassignment on failure

---

## Implementation Order

1. **Auto-Company Bootstrap** — Foundation; enables everything else
2. **Real-Time Notifications** — Extends existing wakeup; needed by all other systems
3. **Approval Gates** — Safety layer; must exist before agents take autonomous actions
4. **Smart Issue Routing** — Depends on active agents (from bootstrap)
5. **Agent Direct Messaging** — Depends on notifications for delivery
6. **Skill Discovery** — Depends on messaging for skill requests
7. **Auto-Recovery** — Final layer; depends on routing for reassignment

## Migration Strategy

- All new tables use Drizzle schema + `pnpm db:push` migration
- Feature flags per company: `autoBootstrapCeo`, `smartRouting`, `approvalGates`, `agentMessaging`, `skillDiscovery`, `autoRecovery`
- Each system is independently toggleable
- Existing companies unaffected unless features enabled
