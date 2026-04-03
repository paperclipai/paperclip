# Issue Creation Spam Prevention — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent duplicate CI failure issues from the GitHub plugin and rate-limit agent issue creation to stop LLM-generated spam.

**Architecture:** Two independent fixes — (1) title-based dedup in the GitHub plugin's webhook handlers, (2) agent-scoped rate limit in the server's issue creation endpoint via a new service method.

**Tech Stack:** TypeScript, Drizzle ORM, Vitest, Paperclip plugin SDK

---

### Task 1: Agent issue creation rate limit

**Files:**
- Modify: `server/src/services/issues.ts` (add `countRecentByAgent` after `countUnreadTouchedByUser` ~line 720)
- Modify: `server/src/routes/issues.ts` (add rate limit check in POST handler ~line 1040)
- Create: `server/src/__tests__/issue-creation-rate-limit.test.ts`

**Step 1: Add `countRecentByAgent` to issue service**

In `server/src/services/issues.ts`, after `countUnreadTouchedByUser` (line ~720), add:

```typescript
    countRecentByAgent: async (agentId: string, windowMs: number = 3_600_000) => {
      const since = new Date(Date.now() - windowMs);
      const [row] = await db
        .select({ count: sql<number>`count(*)` })
        .from(issues)
        .where(
          and(
            eq(issues.createdByAgentId, agentId),
            sql`${issues.createdAt} >= ${since}`,
          ),
        );
      return Number(row?.count ?? 0);
    },
```

**Step 2: Add rate limit check to POST handler**

In `server/src/routes/issues.ts`, after `const actor = getActorInfo(req);` (line ~1040), before the `try { issue = await svc.create(...)`:

```typescript
    // Agent issue creation rate limit
    if (actor.actorType === "agent" && actor.agentId) {
      const recentCount = await svc.countRecentByAgent(actor.agentId);
      const rateLimit = parseInt(process.env.AGENT_ISSUE_CREATION_RATE_LIMIT ?? "5", 10);
      if (recentCount >= rateLimit) {
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.creation_rate_limited",
          entityType: "issue",
          details: { count: recentCount, limit: rateLimit, window: "1h" },
        });
        res.status(429).json({
          error: "rate_limited",
          gate: "issue_creation_rate_limit",
          message: `Agent created ${recentCount} issues in the last hour (limit: ${rateLimit})`,
        });
        return;
      }
    }
```

**Step 3: Write tests, run, verify all pass**

Create `server/src/__tests__/issue-creation-rate-limit.test.ts` with 5 tests:
1. Returns 429 when agent exceeds rate limit (countRecentByAgent returns 5, default limit 5)
2. Allows creation when under rate limit (countRecentByAgent returns 4)
3. Bypasses rate limit for board users (actor.type === "user")
4. Respects AGENT_ISSUE_CREATION_RATE_LIMIT env override
5. Logs rate limit events to activity log

Follow the mock pattern from `server/src/__tests__/delivery-gate.test.ts`. Mock `issueService` to include `countRecentByAgent`.

Run: `npx vitest run server/src/__tests__/issue-creation-rate-limit.test.ts`

**Step 4: Commit**

```bash
git add server/src/services/issues.ts server/src/routes/issues.ts server/src/__tests__/issue-creation-rate-limit.test.ts
git commit -m "feat(issues): agent issue creation rate limit (5/hour default)"
```

---

### Task 2: GitHub plugin CI issue dedup

**Files:**
- Modify: `packages/plugins/github-integration/src/worker.ts`

No new test file — this plugin has zero existing tests and creating a plugin test harness is out of scope.

**Step 1: Add `findExistingCIIssue` helper**

After line 148 (end of `markDelivery`), before the `// Event handlers` section:

```typescript
// ---------------------------------------------------------------------------
// CI issue dedup — find existing open issue by title prefix
// ---------------------------------------------------------------------------

async function findExistingCIIssue(
  companyId: string,
  titlePrefix: string,
): Promise<{ id: string; title: string } | null> {
  if (!ctx) return null;
  try {
    const openIssues = await ctx.issues.list({
      companyId,
      status: "backlog,todo,in_progress,in_review",
      limit: 50,
      offset: 0,
    });
    return openIssues.find((i) => i.title.startsWith(titlePrefix)) ?? null;
  } catch (err) {
    ctx.logger.warn(`Failed to check for existing CI issue: ${err}`);
    return null;
  }
}
```

**Step 2: Wire into `handleWorkflowRun` (lines 182-196)**

Replace the title/description/create block with dedup-aware version:

```typescript
  const titlePrefix = `CI failure: ${run.name}`;
  const title = `${titlePrefix} #${run.run_number} on ${repo}`;
  const description = buildWorkflowRunDescription(payload);

  const existing = await findExistingCIIssue(config.companyId, titlePrefix);
  if (existing) {
    ctx?.logger.info(`Commenting on existing issue ${existing.id} instead of creating duplicate`);
    await ctx!.issues.createComment(existing.id, `**Re-occurrence:** ${title}\n\n${description}`, config.companyId);
    return;
  }

  ctx?.logger.info(`Creating issue: ${title}`);

  await ctx!.issues.create({
    companyId: config.companyId,
    goalId: config.goalId || undefined,
    title,
    description,
    priority: "high",
    status: "todo",
    assigneeAgentId,
  });
```

**Step 3: Wire into `handleCheckRun` (lines 229-245)**

Same pattern:

```typescript
  const titlePrefix = `PR gate failure: ${check.name} on ${repo}`;
  const title = titlePrefix;
  const description = buildCheckRunDescription(payload);

  const existing = await findExistingCIIssue(config.companyId, titlePrefix);
  if (existing) {
    ctx?.logger.info(`Commenting on existing issue ${existing.id} instead of creating duplicate`);
    await ctx!.issues.createComment(existing.id, `**Re-occurrence:** ${title}\n\n${description}`, config.companyId);
    return;
  }

  ctx?.logger.info(`Creating issue: ${title}`);

  const assigneeAgentId = config.defaultAssigneeAgentId || undefined;

  await ctx!.issues.create({
    companyId: config.companyId,
    goalId: config.goalId || undefined,
    title,
    description,
    priority: "high",
    status: "todo",
    assigneeAgentId,
  });
```

**Step 4: Typecheck + commit**

Run: `npx tsc --noEmit --project packages/plugins/github-integration/tsconfig.json`

```bash
git add packages/plugins/github-integration/src/worker.ts
git commit -m "feat(github-plugin): dedup CI failure issues by title prefix"
```
