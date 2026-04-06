# Full Autonomous Company Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make newly created companies immediately operational with an auto-bootstrapped CEO, smart issue routing, approval gates, real-time notifications, agent messaging, skill discovery, and auto-recovery.

**Architecture:** Extend the existing PaperClipNew platform by hooking into company creation, the heartbeat/wakeup system, and the existing approvals infrastructure. Each system is a self-contained module that integrates through the wakeup request pipeline. New DB tables use Drizzle ORM with `pnpm db:push`.

**Tech Stack:** TypeScript, Express, Drizzle ORM (PostgreSQL), React + TanStack Query, Zod validation, existing heartbeat/wakeup/approval infrastructure.

**Spec:** `docs/superpowers/specs/2026-04-05-full-autonomous-company-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `packages/db/src/schema/agent_messages.ts` | Agent direct messaging table schema |
| `packages/db/src/schema/agent_skill_requests.ts` | Skill request tracking table schema |
| `server/src/services/company-bootstrap.ts` | Auto-create CEO on company creation |
| `server/src/services/issue-router.ts` | Smart issue routing with capability matching |
| `server/src/services/agent-messages.ts` | Agent messaging CRUD + broadcast |
| `server/src/services/skill-discovery.ts` | Skill registry search + auto-assignment |
| `server/src/services/auto-recovery.ts` | Retry, reassign, escalate on failures |
| `server/src/routes/agent-messages.ts` | REST endpoints for agent messaging |
| `ui/src/pages/AgentMessages.tsx` | Message viewer component in UI |

### Modified Files
| File | Changes |
|------|---------|
| `packages/db/src/schema/companies.ts` | Add `autoBootstrapCeo`, `defaultCeoModel` columns |
| `packages/db/src/schema/index.ts` | Export new tables |
| `packages/shared/src/constants.ts` | Add new approval types, wakeup sources |
| `packages/shared/src/types/index.ts` | Export new types |
| `server/src/routes/companies.ts` | Hook bootstrap after company creation |
| `server/src/routes/issues.ts` | Add auto-routing + @mention detection in comments |
| `server/src/routes/approvals.ts` | Add wakeup on approval resolution |
| `server/src/routes/index.ts` | Mount agent-messages router |
| `server/src/services/index.ts` | Export new services |
| `server/src/services/heartbeat.ts` | Add stale run cleanup, retry logic, new wakeup sources |
| `server/src/services/issue-assignment-wakeup.ts` | Extend with mention wakeups |
| `ui/src/App.tsx` | Add agent messages route |

---

## Chunk 1: Auto-Company Bootstrap

### Task 1.1: Add Bootstrap Columns to Companies Schema

**Files:**
- Modify: `packages/db/src/schema/companies.ts`

- [ ] **Step 1: Add `autoBootstrapCeo` and `defaultCeoModel` columns**

In `packages/db/src/schema/companies.ts`, add two new columns after `feedbackDataSharingTermsVersion`:

```typescript
autoBootstrapCeo: boolean("auto_bootstrap_ceo").notNull().default(true),
defaultCeoModel: text("default_ceo_model").default("sonnet"),
```

Import `boolean` if not already imported (it is already imported in this file).

- [ ] **Step 2: Push schema changes**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm db:push`
Expected: Schema changes applied successfully.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/schema/companies.ts
git commit -m "feat: add autoBootstrapCeo and defaultCeoModel columns to companies"
```

---

### Task 1.2: Create Company Bootstrap Service

**Files:**
- Create: `server/src/services/company-bootstrap.ts`
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Create the bootstrap service**

Create `server/src/services/company-bootstrap.ts`:

```typescript
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, companies } from "@paperclipai/db";
import { agentService } from "./agents.js";
import { logActivity } from "./activity-log.js";

/**
 * Accept a pre-initialized heartbeat instance to avoid creating a
 * second heartbeatService(db) which has internal state (locks, maps).
 * The route layer should pass its own heartbeat reference.
 */
export function companyBootstrapService(db: Db, heartbeat: { wakeup: Function }) {
  const agentSvc = agentService(db);

  return {
    /**
     * Auto-create a CEO agent for a newly created company.
     * Called after company creation if autoBootstrapCeo is true.
     */
    async bootstrapCeo(companyId: string, options?: {
      ceoModel?: string;
      actorUserId?: string;
    }): Promise<{ agentId: string } | null> {
      // Check company settings
      const [company] = await db
        .select()
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);

      if (!company) return null;

      // Check if CEO already exists
      const existingCeo = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .then((rows) => rows.find((r) => r.id)); // Find any agent with role "ceo"

      // Actually check by role
      const existingCeoByRole = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.companyId, companyId))
        .then((rows) => rows); // We need to check role field

      // Use agentSvc.list() (not listByCompany — that method doesn't exist)
      const allAgents = await agentSvc.list(companyId);
      const ceoAgent = allAgents.find((a) => a.role === "ceo" && a.status !== "terminated");
      if (ceoAgent) {
        return { agentId: ceoAgent.id };
      }

      const model = options?.ceoModel ?? (company as Record<string, unknown>).defaultCeoModel as string ?? "sonnet";

      // Create CEO agent
      const ceo = await agentSvc.create(companyId, {
        name: "CEO",
        role: "ceo",
        title: "Chief Executive Officer",
        status: "idle",
        adapterType: "claude_local",
        adapterConfig: { model },
        runtimeConfig: {},
        budgetMonthlyCents: 500,
        spentMonthlyCents: 0,
        capabilities: "leadership, strategy, hiring, delegation, company management",
        permissions: { canCreateAgents: true },
        lastHeartbeatAt: null,
      });

      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "auto-bootstrap",
        action: "agent.created",
        entityType: "agent",
        entityId: ceo.id,
        details: { name: "CEO", role: "ceo", reason: "auto-bootstrap" },
      });

      // Wake the CEO to start onboarding
      await heartbeat.wakeup(ceo.id, {
        source: "automation",
        triggerDetail: "system",
        reason: "Company bootstrap — CEO initialized, ready for onboarding",
        payload: { companyId, companyName: company.name, bootstrapAction: "onboard" },
        requestedByActorType: "system",
        requestedByActorId: "auto-bootstrap",
      });

      return { agentId: ceo.id };
    },
  };
}
```

- [ ] **Step 2: Export from services index**

In `server/src/services/index.ts`, add:

```typescript
export { companyBootstrapService } from "./company-bootstrap.js";
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/company-bootstrap.ts server/src/services/index.ts
git commit -m "feat: add company bootstrap service for auto-creating CEO agent"
```

---

### Task 1.3: Hook Bootstrap into Company Creation Route

**Files:**
- Modify: `server/src/routes/companies.ts`

- [ ] **Step 1: Import the bootstrap service**

At the top of `server/src/routes/companies.ts`, add to the imports from services:

```typescript
import { companyBootstrapService } from "../services/company-bootstrap.js";
import { heartbeatService } from "../services/heartbeat.js";
```

(If `heartbeatService` is already imported, skip that line.)

- [ ] **Step 2: Initialize the service in the route factory**

Inside the `companyRoutes(db: Db)` function body, after existing service initializations (find where `heartbeatService(db)` is used, or initialize it), add:

```typescript
const heartbeat = heartbeatService(db); // may already exist in this file
const bootstrap = companyBootstrapService(db, heartbeat);
```

- [ ] **Step 3: Add bootstrap call after company creation**

In the `POST /` route handler, after the `res.status(201).json(company)` line (line ~288), add the bootstrap call. Replace the entire route handler from `res.status(201).json(company);` onward:

```typescript
    res.status(201).json(company);

    // Auto-bootstrap CEO if enabled (fire-and-forget, don't block response)
    if ((company as Record<string, unknown>).autoBootstrapCeo !== false) {
      void bootstrap.bootstrapCeo(company.id, {
        actorUserId: req.actor.userId ?? undefined,
      }).catch((err) => {
        console.error(`[company-bootstrap] Failed to bootstrap CEO for ${company.id}:`, err);
      });
    }
```

- [ ] **Step 4: Verify build**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm build`
Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/companies.ts
git commit -m "feat: auto-bootstrap CEO agent on company creation"
```

---

## Chunk 2: Real-Time Agent Notifications

### Task 2.1: Extend Wakeup Sources

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Add new wakeup source constants**

Find `APPROVAL_TYPES` in `packages/shared/src/constants.ts` and look nearby for wakeup-related constants. If none exist at the shared level, we'll add them. Search for existing wakeup source definitions first.

If wakeup sources are only defined as string literals in heartbeat.ts, add to `packages/shared/src/constants.ts`:

```typescript
export const WAKEUP_SOURCES = [
  "timer",
  "assignment",
  "on_demand",
  "automation",
  "mention",
  "approval_response",
  "message",
  "skill_available",
] as const;
export type WakeupSource = (typeof WAKEUP_SOURCES)[number];
```

- [ ] **Step 2: Update WakeupOptions interface in heartbeat.ts**

In `server/src/services/heartbeat.ts`, find the `WakeupOptions` interface (around line 289) and update the `source` field:

```typescript
interface WakeupOptions {
  source?: "timer" | "assignment" | "on_demand" | "automation" | "mention" | "approval_response" | "message" | "skill_available";
  // ... rest stays the same
}
```

- [ ] **Step 3: Update WakeupSource type in issue-assignment-wakeup.ts**

In `server/src/services/issue-assignment-wakeup.ts`, find the `WakeupSource` type (line 4) and update:

```typescript
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation" | "mention" | "approval_response" | "message" | "skill_available";
```

- [ ] **Step 4: Update HEARTBEAT_INVOCATION_SOURCES in shared constants**

In `packages/shared/src/constants.ts`, find `HEARTBEAT_INVOCATION_SOURCES` (line 289) and update:

```typescript
export const HEARTBEAT_INVOCATION_SOURCES = [
  "timer",
  "assignment",
  "on_demand",
  "automation",
  "mention",
  "approval_response",
  "message",
  "skill_available",
] as const;
```

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/constants.ts server/src/services/heartbeat.ts server/src/services/issue-assignment-wakeup.ts
git commit -m "feat: add centralized wakeup source constants and update type interfaces"
```

---

### Task 2.2: Add @Mention Detection in Issue Comments

**Files:**
- Modify: `server/src/routes/issues.ts`
- Modify: `server/src/services/issue-assignment-wakeup.ts`

- [ ] **Step 1: Create mention extraction helper**

At the top of `server/src/services/issue-assignment-wakeup.ts`, add a mention extraction function:

```typescript
/**
 * Extract agent IDs mentioned via @AgentName in text.
 * Case-insensitive match against known agents in the company.
 */
export function extractAgentMentions(
  text: string,
  companyAgents: Array<{ id: string; name: string; status: string }>,
): string[] {
  const mentionedIds: string[] = [];
  for (const agent of companyAgents) {
    if (agent.status === "terminated") continue;
    // Match @AgentName (case-insensitive, word boundary)
    const pattern = new RegExp(`@${agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    if (pattern.test(text)) {
      mentionedIds.push(agent.id);
    }
  }
  return mentionedIds;
}

/**
 * Queue wakeup requests for all mentioned agents.
 */
export function queueMentionWakeups(input: {
  heartbeat: IssueAssignmentWakeupDeps;
  issueId: string;
  mentionedAgentIds: string[];
  commentId?: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
}) {
  for (const agentId of input.mentionedAgentIds) {
    void input.heartbeat
      .wakeup(agentId, {
        source: "mention",
        triggerDetail: "system",
        reason: `Mentioned in issue comment`,
        payload: { issueId: input.issueId, commentId: input.commentId },
        requestedByActorType: input.requestedByActorType,
        requestedByActorId: input.requestedByActorId ?? null,
      })
      .catch((err: unknown) => {
        console.error(`[mention-wakeup] Failed to wake agent ${agentId}:`, err);
      });
  }
}
```

- [ ] **Step 2: Hook mention detection into issue comment creation**

In `server/src/routes/issues.ts`, in the POST `/issues/:id/comments` handler (around line 1601-1630), after the comment is created, add:

```typescript
// Detect @mentions and wake mentioned agents
const agentSvc = agentService(db);
const allAgents = await agentSvc.listByCompany(issue.companyId);
const mentionedIds = extractAgentMentions(req.body.body ?? "", allAgents);
if (mentionedIds.length > 0) {
  queueMentionWakeups({
    heartbeat,
    issueId: issue.id,
    mentionedAgentIds: mentionedIds,
    commentId: comment.id,
    requestedByActorType: actor.actorType,
    requestedByActorId: actor.actorId,
  });
}
```

Add the imports at the top of `server/src/routes/issues.ts`:

```typescript
import { extractAgentMentions, queueMentionWakeups } from "../services/issue-assignment-wakeup.js";
import { agentService } from "../services/agents.js";
```

- [ ] **Step 3: Verify build**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm build`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/issue-assignment-wakeup.ts server/src/routes/issues.ts
git commit -m "feat: detect @mentions in issue comments and wake mentioned agents"
```

---

### Task 2.3: ~~Wake Agent on Approval Resolution~~ — SKIP

> **NOTE:** The existing `server/src/routes/approvals.ts` already wakes the requesting agent on both approve (lines 233-295) and reject (lines 326-391) via `heartbeat.wakeup(approval.requestedByAgentId, ...)`. No changes needed here. This task is a no-op.

---

## Chunk 3: Approval Gates (Spending, Strategy, Termination)

The existing `approvals` table and routes already support the `hire_agent`, `approve_ceo_strategy`, and `budget_override_required` types. We need to:
1. Add a `terminate_agent` approval type
2. Add spending threshold checks before agent execution
3. Ensure the CEO agent creates approvals for strategy/hiring decisions

### Task 3.1: Add Termination Approval Type

**Files:**
- Modify: `packages/shared/src/constants.ts`

- [ ] **Step 1: Add `terminate_agent` to APPROVAL_TYPES**

In `packages/shared/src/constants.ts`, find the `APPROVAL_TYPES` array and add:

```typescript
export const APPROVAL_TYPES = ["hire_agent", "approve_ceo_strategy", "budget_override_required", "terminate_agent"] as const;
```

> **NOTE:** The `createApprovalSchema` in `packages/shared/src/validators/approval.ts` uses `z.enum(APPROVAL_TYPES)`, so adding the value here automatically makes it valid in the Zod schema too. No additional validator changes needed.

- [ ] **Step 2: Commit**

```bash
git add packages/shared/src/constants.ts
git commit -m "feat: add terminate_agent approval type"
```

---

### Task 3.2: Add Termination Approval Gate

**Files:**
- Modify: `server/src/routes/agents.ts`

- [ ] **Step 1: Find the agent termination route**

In `server/src/routes/agents.ts`, find the `POST /agents/:id/terminate` route.

- [ ] **Step 2: Add approval gate for agent-initiated terminations**

When an **agent** requests to terminate another agent, require approval instead of executing immediately. Modify the terminate handler:

```typescript
// If termination is requested by an agent, require approval gate
if (req.actor.type === "agent") {
  const approvalSvc = approvalService(db);
  const approval = await approvalSvc.create(agent.companyId, {
    type: "terminate_agent",
    payload: {
      targetAgentId: agent.id,
      targetAgentName: agent.name,
      reason: req.body.reason ?? "Requested by agent",
    },
    requestedByAgentId: req.actor.agentId,
  });

  await logActivity(db, {
    companyId: agent.companyId,
    actorType: "agent",
    actorId: req.actor.agentId,
    action: "approval.created",
    entityType: "approval",
    entityId: approval.id,
    details: { type: "terminate_agent", targetAgentId: agent.id },
  });

  res.status(202).json({
    message: "Termination requires approval",
    approvalId: approval.id,
  });
  return;
}
```

This only gates agent-initiated terminations. Human/board terminations proceed as normal.

> **UI NOTE:** The new `terminate_agent` and `budget_override_required` approval types will appear in the existing approvals UI page (which lists all approvals by company). The existing approval list/resolve UI handles any approval type generically. No new `ApprovalGates.tsx` page is needed — the existing approvals page covers it.

- [ ] **Step 3: Verify build**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm build`

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/agents.ts
git commit -m "feat: require approval gate for agent-initiated terminations"
```

---

### Task 3.3: Add Spending Threshold Check

**Files:**
- Modify: `server/src/services/heartbeat.ts`

- [ ] **Step 1: Find the heartbeat execution entry point**

In `server/src/services/heartbeat.ts`, find where a heartbeat run transitions from `queued` to `running` (the `execute` or `processRun` function).

- [ ] **Step 2: Add pre-execution spending check**

Before executing the adapter, check if the estimated cost exceeds the $5 threshold. If so, create an approval gate:

```typescript
// Spending gate: if agent has a budget and recent run costs suggest this will exceed $5/task
const SPENDING_THRESHOLD_CENTS = 500; // $5
const recentRuns = await db
  .select()
  .from(heartbeatRuns)
  .where(
    and(
      eq(heartbeatRuns.agentId, agentId),
      eq(heartbeatRuns.status, "completed"),
    ),
  )
  .orderBy(desc(heartbeatRuns.finishedAt))
  .limit(5);

const avgCost = recentRuns.length > 0
  ? recentRuns.reduce((sum, r) => {
      const cost = (r.usageJson as Record<string, unknown>)?.totalCostCents;
      return sum + (typeof cost === "number" ? cost : 0);
    }, 0) / recentRuns.length
  : 0;

if (avgCost > SPENDING_THRESHOLD_CENTS) {
  // Create a budget approval request
  const approvalSvc = approvalService(db);
  await approvalSvc.create(agent.companyId, {
    type: "budget_override_required",
    payload: {
      agentId: agent.id,
      agentName: agent.name,
      estimatedCostCents: Math.round(avgCost),
      threshold: SPENDING_THRESHOLD_CENTS,
      reason: `Estimated task cost ($${(avgCost / 100).toFixed(2)}) exceeds $5 threshold`,
    },
    requestedByAgentId: agent.id,
  });
  // Skip this run — agent will be woken when approval resolves
  return;
}
```

Note: This is a heuristic based on recent average. The exact integration point depends on the heartbeat execution flow. Read the execute path carefully before inserting.

- [ ] **Step 3: Verify build**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm build`

- [ ] **Step 4: Commit**

```bash
git add server/src/services/heartbeat.ts
git commit -m "feat: add spending threshold gate ($5) before agent execution"
```

---

## Chunk 4: Smart Issue Routing

### Task 4.1: Create Issue Router Service

**Files:**
- Create: `server/src/services/issue-router.ts`
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Create the issue router service**

Create `server/src/services/issue-router.ts`:

```typescript
import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issues } from "@paperclipai/db";

interface IssueForRouting {
  id: string;
  title: string;
  description?: string | null;
  priority?: string | null;
}

interface AgentForRouting {
  id: string;
  name: string;
  role: string;
  capabilities: string | null;
  status: string;
}

/**
 * Compute a keyword overlap score between an issue and an agent's capabilities.
 */
function computeCapabilityScore(agent: AgentForRouting, issue: IssueForRouting): number {
  if (!agent.capabilities) return 0;
  const issueText = `${issue.title} ${issue.description ?? ""}`.toLowerCase();
  const keywords = agent.capabilities
    .toLowerCase()
    .split(/[,;\s]+/)
    .filter((k) => k.length > 2);
  if (keywords.length === 0) return 0;
  const matches = keywords.filter((k) => issueText.includes(k)).length;
  return matches / keywords.length;
}

/**
 * Compute a load score (lower active issues = higher score).
 */
async function computeLoadScore(db: Db, agentId: string): Promise<number> {
  const result = await db
    .select({ count: sql<number>`count(*)` })
    .from(issues)
    .where(
      and(
        eq(issues.assigneeAgentId, agentId),
        ne(issues.status, "done"),
        ne(issues.status, "cancelled"),
      ),
    );
  const activeCount = result[0]?.count ?? 0;
  // Score inversely proportional to active issues (max 1.0 at 0 issues)
  return Math.max(0, 1 - activeCount * 0.15);
}

export function issueRouterService(db: Db) {
  return {
    /**
     * Find the best agent to handle an issue based on capabilities and load.
     * Returns agent ID or null if no suitable agent found.
     */
    async routeIssue(companyId: string, issue: IssueForRouting): Promise<string | null> {
      const allAgents = await db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            ne(agents.status, "terminated"),
            ne(agents.status, "paused"),
          ),
        );

      if (allAgents.length === 0) return null;

      // Score each agent
      const scored: Array<{ agent: AgentForRouting; score: number }> = [];
      for (const agent of allAgents) {
        const capScore = computeCapabilityScore(agent, issue);
        const loadScore = await computeLoadScore(db, agent.id);
        // CEO gets a small bonus as fallback
        const ceoBonus = agent.role === "ceo" ? 0.1 : 0;
        scored.push({
          agent,
          score: capScore * 0.6 + loadScore * 0.3 + ceoBonus,
        });
      }

      scored.sort((a, b) => b.score - a.score);

      // If best score is 0 (no capability match at all), fall back to CEO
      if (scored[0]?.score === 0) {
        const ceo = allAgents.find((a) => a.role === "ceo");
        return ceo?.id ?? scored[0]?.agent.id ?? null;
      }

      return scored[0]?.agent.id ?? null;
    },

    /**
     * Get the CEO agent ID for a company.
     */
    async getCeoAgentId(companyId: string): Promise<string | null> {
      const rows = await db
        .select({ id: agents.id })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, companyId),
            eq(agents.role, "ceo"),
            ne(agents.status, "terminated"),
          ),
        )
        .limit(1);
      return rows[0]?.id ?? null;
    },
  };
}
```

- [ ] **Step 2: Export from services index**

In `server/src/services/index.ts`, add:

```typescript
export { issueRouterService } from "./issue-router.js";
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/issue-router.ts server/src/services/index.ts
git commit -m "feat: add smart issue routing service with capability matching"
```

---

### Task 4.2: Hook Auto-Routing into Issue Creation

**Files:**
- Modify: `server/src/routes/issues.ts`

- [ ] **Step 1: Import the issue router**

In `server/src/routes/issues.ts`, add import:

```typescript
import { issueRouterService } from "../services/issue-router.js";
```

And initialize it in the route factory:

```typescript
const issueRouter = issueRouterService(db);
```

- [ ] **Step 2: Add auto-routing after issue creation**

In the `POST /companies/:companyId/issues` handler (around line 1020-1034), after the issue is created and **before** the wakeup call, add auto-routing when no assignee:

```typescript
// Auto-route if no assignee specified
let routedIssue = issue;
if (!issue.assigneeAgentId) {
  const bestAgentId = await issueRouter.routeIssue(companyId, {
    id: issue.id,
    title: issue.title,
    description: issue.description,
  });
  if (bestAgentId) {
    routedIssue = await svc.update(issue.id, { assigneeAgentId: bestAgentId });
    await logActivity(db, {
      companyId,
      actorType: "system",
      actorId: "issue-router",
      action: "issue.assigned",
      entityType: "issue",
      entityId: issue.id,
      details: { assigneeAgentId: bestAgentId, reason: "auto-routed" },
    });
  }
}
```

Then pass `routedIssue` to the wakeup call instead of `issue`.

- [ ] **Step 3: Verify build**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm build`

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/issues.ts
git commit -m "feat: auto-route unassigned issues to best-fit agent"
```

---

## Chunk 5: Agent Direct Messaging

### Task 5.1: Create Agent Messages Schema

**Files:**
- Create: `packages/db/src/schema/agent_messages.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the schema file**

Create `packages/db/src/schema/agent_messages.ts`:

```typescript
import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentMessages = pgTable(
  "agent_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    fromAgentId: uuid("from_agent_id").notNull().references(() => agents.id),
    toAgentId: uuid("to_agent_id").references(() => agents.id),
    broadcastScope: text("broadcast_scope"), // 'team' | 'company' | null
    messageType: text("message_type").notNull().default("general"),
    subject: text("subject"),
    body: text("body").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyFromIdx: index("agent_messages_company_from_idx").on(table.companyId, table.fromAgentId),
    companyToIdx: index("agent_messages_company_to_idx").on(table.companyId, table.toAgentId),
    toAgentCreatedIdx: index("agent_messages_to_agent_created_idx").on(table.toAgentId, table.createdAt),
  }),
);
```

- [ ] **Step 2: Export from schema index**

In `packages/db/src/schema/index.ts`, add:

```typescript
export { agentMessages } from "./agent_messages.js";
```

- [ ] **Step 3: Push schema**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm db:push`

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/agent_messages.ts packages/db/src/schema/index.ts
git commit -m "feat: add agent_messages table schema"
```

---

### Task 5.2: Create Agent Messages Service

**Files:**
- Create: `server/src/services/agent-messages.ts`
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Create the messaging service**

Create `server/src/services/agent-messages.ts`:

```typescript
import { and, desc, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentMessages, agents } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";

export function agentMessageService(db: Db) {
  const heartbeat = heartbeatService(db);

  return {
    /**
     * Send a direct message from one agent to another.
     * Triggers wakeup for recipient(s).
     */
    async send(input: {
      companyId: string;
      fromAgentId: string;
      toAgentId?: string | null;
      broadcastScope?: "team" | "company" | null;
      messageType?: string;
      subject?: string | null;
      body: string;
      metadata?: Record<string, unknown>;
    }) {
      const [msg] = await db
        .insert(agentMessages)
        .values({
          companyId: input.companyId,
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId ?? null,
          broadcastScope: input.broadcastScope ?? null,
          messageType: input.messageType ?? "general",
          subject: input.subject ?? null,
          body: input.body,
          metadata: input.metadata ?? null,
        })
        .returning();

      // Wake recipient(s)
      if (input.toAgentId) {
        void heartbeat
          .wakeup(input.toAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: `New message from agent: ${input.messageType}`,
            payload: { messageId: msg.id, fromAgentId: input.fromAgentId },
            requestedByActorType: "agent",
            requestedByActorId: input.fromAgentId,
          })
          .catch((err: unknown) => {
            console.error(`[agent-message] Failed to wake recipient ${input.toAgentId}:`, err);
          });
      } else if (input.broadcastScope) {
        // Broadcast: wake all agents in scope
        const scopeFilter =
          input.broadcastScope === "company"
            ? eq(agents.companyId, input.companyId)
            : and(
                eq(agents.companyId, input.companyId),
                eq(agents.reportsTo, input.fromAgentId),
              );
        const targets = await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(scopeFilter, eq(agents.status, "idle")));

        for (const target of targets) {
          if (target.id === input.fromAgentId) continue; // Don't wake self
          void heartbeat
            .wakeup(target.id, {
              source: "automation",
              triggerDetail: "system",
              reason: `Broadcast message: ${input.messageType}`,
              payload: { messageId: msg.id, fromAgentId: input.fromAgentId },
              requestedByActorType: "agent",
              requestedByActorId: input.fromAgentId,
            })
            .catch(() => {}); // Best effort for broadcasts
        }
      }

      return msg;
    },

    /**
     * List messages for a specific agent (sent to them or broadcast).
     */
    async listForAgent(companyId: string, agentId: string, options?: { unreadOnly?: boolean }) {
      const conditions = [
        eq(agentMessages.companyId, companyId),
        or(
          eq(agentMessages.toAgentId, agentId),
          and(isNull(agentMessages.toAgentId), eq(agentMessages.broadcastScope, "company")),
        ),
      ];

      if (options?.unreadOnly) {
        conditions.push(isNull(agentMessages.readAt));
      }

      return db
        .select()
        .from(agentMessages)
        .where(and(...conditions))
        .orderBy(desc(agentMessages.createdAt))
        .limit(100);
    },

    /**
     * Mark a message as read.
     */
    async markRead(messageId: string) {
      const [updated] = await db
        .update(agentMessages)
        .set({ readAt: new Date(), updatedAt: new Date() })
        .where(eq(agentMessages.id, messageId))
        .returning();
      return updated;
    },

    /**
     * Count unread messages for an agent.
     */
    async countUnread(companyId: string, agentId: string): Promise<number> {
      const rows = await db
        .select()
        .from(agentMessages)
        .where(
          and(
            eq(agentMessages.companyId, companyId),
            or(
              eq(agentMessages.toAgentId, agentId),
              and(isNull(agentMessages.toAgentId), eq(agentMessages.broadcastScope, "company")),
            ),
            isNull(agentMessages.readAt),
          ),
        );
      return rows.length;
    },
  };
}
```

- [ ] **Step 2: Export from services index**

In `server/src/services/index.ts`, add:

```typescript
export { agentMessageService } from "./agent-messages.js";
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/agent-messages.ts server/src/services/index.ts
git commit -m "feat: add agent direct messaging service with wakeup integration"
```

---

### Task 5.3: Create Agent Messages Routes

**Files:**
- Create: `server/src/routes/agent-messages.ts`
- Modify: `server/src/routes/index.ts`

- [ ] **Step 1: Create the routes file**

Create `server/src/routes/agent-messages.ts`:

```typescript
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agentMessageService, logActivity } from "../services/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";

export function agentMessageRoutes(db: Db) {
  const router = Router();
  const svc = agentMessageService(db);

  // Send a message
  router.post("/companies/:companyId/agent-messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = getActorInfo(req);

    const { fromAgentId, toAgentId, broadcastScope, messageType, subject, body, metadata } = req.body;

    if (!fromAgentId || !body) {
      res.status(400).json({ error: "fromAgentId and body are required" });
      return;
    }

    const msg = await svc.send({
      companyId,
      fromAgentId,
      toAgentId: toAgentId ?? null,
      broadcastScope: broadcastScope ?? null,
      messageType: messageType ?? "general",
      subject: subject ?? null,
      body,
      metadata: metadata ?? undefined,
    });

    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: "agent_message.sent",
      entityType: "agent_message",
      entityId: msg.id,
      details: { fromAgentId, toAgentId, messageType: messageType ?? "general" },
    });

    res.status(201).json(msg);
  });

  // List messages for an agent
  router.get("/companies/:companyId/agent-messages", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const agentId = req.query.agentId as string;
    const unreadOnly = req.query.unreadOnly === "true";

    if (!agentId) {
      res.status(400).json({ error: "agentId query param required" });
      return;
    }

    const messages = await svc.listForAgent(companyId, agentId, { unreadOnly });
    res.json(messages);
  });

  // Mark message as read
  router.patch("/agent-messages/:id/read", async (req, res) => {
    const id = req.params.id as string;
    const updated = await svc.markRead(id);
    if (!updated) {
      res.status(404).json({ error: "Message not found" });
      return;
    }
    res.json(updated);
  });

  return router;
}
```

- [ ] **Step 2: Mount in routes index**

In `server/src/routes/index.ts`, add:

```typescript
export { agentMessageRoutes } from "./agent-messages.js";
```

- [ ] **Step 3: Mount the router in the server**

Find where routes are mounted in the main server file (likely `server/src/server.ts` or `server/src/app.ts`) and add:

```typescript
app.use("/api", agentMessageRoutes(db));
```

Follow the same pattern used for other routes.

- [ ] **Step 4: Verify build**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm build`

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/agent-messages.ts server/src/routes/index.ts
git commit -m "feat: add agent messaging REST API endpoints"
```

---

## Chunk 6: Skill Discovery & Auto-Learning

### Task 6.1: Create Skill Requests Schema

**Files:**
- Create: `packages/db/src/schema/agent_skill_requests.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the schema file**

Create `packages/db/src/schema/agent_skill_requests.ts`:

```typescript
import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { agents } from "./agents.js";

export const agentSkillRequests = pgTable(
  "agent_skill_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    agentId: uuid("agent_id").notNull().references(() => agents.id),
    skillName: text("skill_name").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"), // pending | approved | denied | auto_approved
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: text("resolved_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyAgentIdx: index("agent_skill_requests_company_agent_idx").on(table.companyId, table.agentId),
    companyStatusIdx: index("agent_skill_requests_company_status_idx").on(table.companyId, table.status),
  }),
);
```

- [ ] **Step 2: Export from schema index**

In `packages/db/src/schema/index.ts`, add:

```typescript
export { agentSkillRequests } from "./agent_skill_requests.js";
```

- [ ] **Step 3: Push schema**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm db:push`

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/agent_skill_requests.ts packages/db/src/schema/index.ts
git commit -m "feat: add agent_skill_requests table schema"
```

---

### Task 6.2: Create Skill Discovery Service

**Files:**
- Create: `server/src/services/skill-discovery.ts`
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Create the skill discovery service**

Create `server/src/services/skill-discovery.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentSkillRequests, companySkills } from "@paperclipai/db";

/**
 * Role-to-skill mapping for auto-assignment on agent creation.
 */
const ROLE_SKILL_MAP: Record<string, string[]> = {
  ceo: ["company-management", "hiring", "strategy", "delegation"],
  developer: ["coding", "debugging", "code-review", "git"],
  designer: ["ui-design", "ux-research", "prototyping"],
  qa: ["testing", "bug-reporting", "automation"],
  devops: ["deployment", "monitoring", "ci-cd"],
  marketing: ["content-writing", "analytics", "social-media"],
  general: [],
};

/**
 * Skills that can be auto-approved without human review.
 */
const AUTO_APPROVE_SKILLS = new Set([
  "coding", "debugging", "code-review", "git",
  "content-writing", "analytics",
  "testing", "bug-reporting",
]);

export function skillDiscoveryService(db: Db) {
  return {
    /**
     * Get recommended skills for a role.
     */
    getSkillsForRole(role: string): string[] {
      return ROLE_SKILL_MAP[role] ?? ROLE_SKILL_MAP.general ?? [];
    },

    /**
     * Auto-assign skills to a newly created agent based on role.
     * Uses the company_skills table to check available skills.
     */
    async autoAssignSkillsForAgent(companyId: string, agentId: string, role: string): Promise<string[]> {
      const recommended = this.getSkillsForRole(role);
      if (recommended.length === 0) return [];

      // Check which skills are available in the company
      const available = await db
        .select()
        .from(companySkills)
        .where(eq(companySkills.companyId, companyId));

      // Match against slug (not name — name is human-readable, slug is the programmatic key)
      const availableSlugs = new Set(available.map((s) => s.slug));
      const toAssign = recommended.filter((s) => availableSlugs.has(s));

      // The actual skill assignment to the agent would go through the
      // existing company-skills or agent-instructions service
      return toAssign;
    },

    /**
     * Request a skill. Auto-approve if in safe list, otherwise pending.
     */
    async requestSkill(input: {
      companyId: string;
      agentId: string;
      skillName: string;
      reason: string;
    }) {
      const autoApprove = AUTO_APPROVE_SKILLS.has(input.skillName);

      const [request] = await db
        .insert(agentSkillRequests)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          skillName: input.skillName,
          reason: input.reason,
          status: autoApprove ? "auto_approved" : "pending",
          resolvedAt: autoApprove ? new Date() : null,
        })
        .returning();

      return request;
    },

    /**
     * Resolve a skill request (approve or deny).
     */
    async resolveRequest(requestId: string, status: "approved" | "denied", userId: string) {
      const [updated] = await db
        .update(agentSkillRequests)
        .set({
          status,
          resolvedAt: new Date(),
          resolvedByUserId: userId,
          updatedAt: new Date(),
        })
        .where(eq(agentSkillRequests.id, requestId))
        .returning();
      return updated;
    },

    /**
     * List pending skill requests for a company.
     */
    async listPending(companyId: string) {
      return db
        .select()
        .from(agentSkillRequests)
        .where(
          and(
            eq(agentSkillRequests.companyId, companyId),
            eq(agentSkillRequests.status, "pending"),
          ),
        );
    },
  };
}
```

- [ ] **Step 2: Export from services index**

In `server/src/services/index.ts`, add:

```typescript
export { skillDiscoveryService } from "./skill-discovery.js";
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/skill-discovery.ts server/src/services/index.ts
git commit -m "feat: add skill discovery service with auto-assignment and request flow"
```

---

## Chunk 7: Auto-Recovery

### Task 7.1: Create Auto-Recovery Service

**Files:**
- Create: `server/src/services/auto-recovery.ts`
- Modify: `server/src/services/index.ts`

- [ ] **Step 1: Create the auto-recovery service**

Create `server/src/services/auto-recovery.ts`:

```typescript
import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, agents } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { issueRouterService } from "./issue-router.js";
import { agentMessageService } from "./agent-messages.js";

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000]; // 5s, 30s, 2min
const STALE_RUN_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

export function autoRecoveryService(db: Db) {
  const heartbeat = heartbeatService(db);
  const issueRouter = issueRouterService(db);
  const messaging = agentMessageService(db);

  return {
    /**
     * Handle a failed heartbeat run with retry logic.
     * Returns true if a retry was scheduled, false if exhausted.
     */
    async handleFailedRun(runId: string): Promise<boolean> {
      const [run] = await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .limit(1);

      if (!run || run.status !== "failed") return false;

      const retryCount = run.processLossRetryCount;
      if (retryCount >= MAX_RETRIES) {
        // Exhausted retries — escalate
        await this.escalateFailure(run.agentId, run.companyId, runId, retryCount);
        return false;
      }

      // Schedule retry with backoff
      const delayMs = RETRY_DELAYS_MS[retryCount] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1];

      // NOTE: In-process setTimeout is NOT restart-safe. If the server restarts
      // between scheduling and execution, the retry is lost. For v1 this is
      // acceptable — the stale cleanup timer will catch orphaned runs.
      // Future improvement: add a `nextRetryAt` column to heartbeat_runs and
      // use the periodic tickTimers to pick up DB-persisted retries.
      setTimeout(async () => {
        try {
          await heartbeat.wakeup(run.agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: `Auto-retry attempt ${retryCount + 1}/${MAX_RETRIES} for failed run ${runId}`,
            payload: { retryOfRunId: runId, retryCount: retryCount + 1 },
            requestedByActorType: "system",
            requestedByActorId: "auto-recovery",
          });
        } catch (err) {
          console.error(`[auto-recovery] Failed to schedule retry for run ${runId}:`, err);
        }
      }, delayMs);

      // Update retry count
      await db
        .update(heartbeatRuns)
        .set({
          processLossRetryCount: retryCount + 1,
          updatedAt: new Date(),
        })
        .where(eq(heartbeatRuns.id, runId));

      return true;
    },

    /**
     * Escalate a failure to the agent's manager or CEO.
     */
    async escalateFailure(
      agentId: string,
      companyId: string,
      runId: string,
      retryCount: number,
    ): Promise<void> {
      const [agent] = await db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);

      if (!agent) return;

      // Find manager or CEO to escalate to
      const escalateToId = agent.reportsTo ?? (await issueRouter.getCeoAgentId(companyId));

      if (escalateToId && escalateToId !== agentId) {
        await messaging.send({
          companyId,
          fromAgentId: agentId,
          toAgentId: escalateToId,
          messageType: "escalation",
          subject: `Agent ${agent.name} failed after ${retryCount} retries`,
          body: `Agent "${agent.name}" has failed ${retryCount} times on run ${runId}. ` +
            `Manual intervention or task reassignment may be needed.`,
          metadata: { failedRunId: runId, retryCount },
        });
      }
    },

    /**
     * Clean up stale heartbeat runs that have been "running" for too long.
     * Should be called periodically (e.g., every 5 minutes).
     */
    async cleanupStaleRuns(): Promise<number> {
      const cutoff = new Date(Date.now() - STALE_RUN_THRESHOLD_MS);

      const staleRuns = await db
        .select()
        .from(heartbeatRuns)
        .where(
          and(
            eq(heartbeatRuns.status, "running"),
            lt(heartbeatRuns.startedAt, cutoff),
          ),
        );

      for (const run of staleRuns) {
        // Mark as failed
        await db
          .update(heartbeatRuns)
          .set({
            status: "failed",
            error: "Stale run detected — exceeded 10 minute timeout",
            errorCode: "STALE_RUN",
            finishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(heartbeatRuns.id, run.id));

        // Try to retry
        await this.handleFailedRun(run.id);
      }

      return staleRuns.length;
    },
  };
}
```

- [ ] **Step 2: Export from services index**

In `server/src/services/index.ts`, add:

```typescript
export { autoRecoveryService } from "./auto-recovery.js";
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/auto-recovery.ts server/src/services/index.ts
git commit -m "feat: add auto-recovery service with retry, escalation, and stale cleanup"
```

---

### Task 7.2: Hook Stale Cleanup into Server Startup

**Files:**
- Modify: `server/src/server.ts` (or wherever the server starts)

- [ ] **Step 1: Find the server startup file**

Look for where the Express app starts (`app.listen`) or where periodic timers are set up. The heartbeat `tickTimers()` is likely called on an interval.

- [ ] **Step 2: Add periodic stale run cleanup**

Near where `tickTimers()` is scheduled, add a cleanup interval:

```typescript
import { autoRecoveryService } from "./services/auto-recovery.js";

// After db is initialized:
const recovery = autoRecoveryService(db);

// Run stale cleanup every 5 minutes
setInterval(async () => {
  try {
    const cleaned = await recovery.cleanupStaleRuns();
    if (cleaned > 0) {
      console.log(`[auto-recovery] Cleaned up ${cleaned} stale runs`);
    }
  } catch (err) {
    console.error("[auto-recovery] Stale cleanup error:", err);
  }
}, 5 * 60 * 1000);
```

- [ ] **Step 3: Hook auto-retry into failed heartbeat runs**

In `server/src/services/heartbeat.ts`, find where a run is marked as `failed` and add:

```typescript
// After marking run as failed:
const recovery = autoRecoveryService(db);
void recovery.handleFailedRun(run.id).catch((err) => {
  console.error(`[auto-recovery] Failed to handle failed run ${run.id}:`, err);
});
```

- [ ] **Step 4: Verify build**

Run: `cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm build`

- [ ] **Step 5: Commit**

```bash
git add server/src/server.ts server/src/services/heartbeat.ts
git commit -m "feat: hook auto-recovery into server startup and failed heartbeat runs"
```

---

## Final: Integration Verification

### Task 8.1: End-to-End Verification

- [ ] **Step 1: Restart the server**

```bash
cd C:\Users\DRRAM\Projects\PaperClipNew && pnpm dev
```

- [ ] **Step 2: Create a new company via UI**

Navigate to http://127.0.0.1:3100 and create a new company. Verify:
- CEO agent is auto-created
- CEO agent receives a wakeup and starts running
- Activity log shows `agent.created` with `reason: auto-bootstrap`

- [ ] **Step 3: Create an issue without assignee**

Create an issue in the new company without specifying an assignee. Verify:
- Issue is auto-routed to the CEO (or best-fit agent)
- Activity log shows `issue.assigned` with `reason: auto-routed`

- [ ] **Step 4: Post a comment with @mention**

Comment on an issue with `@CEO` mention. Verify:
- CEO agent receives a wakeup with `mention` source

- [ ] **Step 5: Check approval gates**

If an agent tries to terminate another agent, verify:
- A `terminate_agent` approval is created
- The termination is blocked until approved

- [ ] **Step 6: Commit final state**

```bash
git add -A
git commit -m "feat: full autonomous company system — bootstrap, routing, notifications, approvals, messaging, skills, recovery"
```
