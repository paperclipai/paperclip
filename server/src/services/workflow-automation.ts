import { and, asc, desc, eq, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, goals, issueComments, issues } from "@paperclipai/db";
import { heartbeatService } from "./heartbeat.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";

const BLOCKED_SLA_HOURS = Math.max(1, Number(process.env.PAPERCLIP_BLOCKED_SLA_HOURS) || 4);
const BLOCKED_SWEEP_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.PAPERCLIP_BLOCKED_SLA_SWEEP_MS) || 5 * 60 * 1000,
);
const DAILY_ROLLUP_HOUR_LOCAL = Math.min(
  23,
  Math.max(0, Number(process.env.PAPERCLIP_DAILY_ROLLUP_HOUR_LOCAL) || 8),
);
const DAILY_ROLLUP_PARENT_PRIORITIES = ["critical"];
const ACTIVE_FANOUT_AGENT_STATUSES = ["active", "idle", "running"];
const AUTO_ACTOR_ID = "workflow-automation";
const AUTO_ACTOR_TYPE = "system" as const;
const LOCAL_TIMEZONE =
  process.env.PAPERCLIP_AUTOMATION_TIMEZONE ||
  process.env.TZ ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  "UTC";

function localDayKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: LOCAL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function localHour(now: Date): number {
  const formatted = new Intl.DateTimeFormat("en-GB", {
    timeZone: LOCAL_TIMEZONE,
    hour: "2-digit",
    hourCycle: "h23",
  }).format(now);
  const parsed = Number.parseInt(formatted, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function issueRef(issue: { identifier: string | null; id: string }) {
  return issue.identifier ?? issue.id;
}

function buildFanoutDescription(input: {
  parentIssue: { id: string; identifier: string | null; title: string; description: string | null };
  ownerName: string;
  goalTitle: string;
}) {
  return [
    `Part of [${issueRef(input.parentIssue)}](/issues/${issueRef(input.parentIssue)}).`,
    "",
    "## Goal",
    input.goalTitle,
    "",
    "## Owner",
    input.ownerName,
    "",
    "## Definition of Done",
    "- [ ] Deliver the assigned Android workstream.",
    "- [ ] Post implementation summary and verification evidence.",
    "",
    "## Dependencies",
    "- [ ] None identified yet (update if blocked).",
    "",
    "## Deadline",
    "- [ ] TBD",
    "",
    "## Context",
    input.parentIssue.description?.trim() || "See parent issue for full context.",
  ].join("\n");
}

export function workflowAutomationService(db: Db) {
  const issuesSvc = issueService(db);
  const heartbeat = heartbeatService(db);
  let lastBlockedSweepAt = 0;
  let lastRollupDay: string | null = null;

  async function fanoutCritical(input: {
    companyId: string;
    parentIssueId: string;
    requestedByAgentId: string | null;
    requestedByUserId: string | null;
    requestedByActorType: "agent" | "user" | "system";
    requestedByActorId: string;
  }) {
    const parentIssue = await issuesSvc.getById(input.parentIssueId);
    if (!parentIssue || parentIssue.companyId !== input.companyId) {
      return {
        created: [] as Array<{ id: string; identifier: string | null; assigneeAgentId: string | null }>,
        duplicates: [] as string[],
        skipped: [] as string[],
      };
    }

    const goalTitle = parentIssue.goalId
      ? await db
        .select({ title: goals.title })
        .from(goals)
        .where(eq(goals.id, parentIssue.goalId))
        .then((rows) => rows[0]?.title ?? parentIssue.title)
      : parentIssue.title;

    const targetAgents = await db
      .select({
        id: agents.id,
        name: agents.name,
        status: agents.status,
      })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, input.companyId),
          inArray(agents.status, [...ACTIVE_FANOUT_AGENT_STATUSES]),
        ),
      )
      .orderBy(asc(agents.name));

    const created: Array<{ id: string; identifier: string | null; assigneeAgentId: string | null }> = [];
    const duplicates: string[] = [];
    const skipped: string[] = [];

    for (const agent of targetAgents) {
      const description = buildFanoutDescription({
        parentIssue: {
          id: parentIssue.id,
          identifier: parentIssue.identifier,
          title: parentIssue.title,
          description: parentIssue.description,
        },
        ownerName: agent.name,
        goalTitle,
      });
      try {
        const child = await issuesSvc.create(input.companyId, {
          projectId: parentIssue.projectId,
          goalId: parentIssue.goalId,
          parentId: parentIssue.id,
          title: parentIssue.title,
          description,
          status: "todo",
          priority: "critical",
          assigneeAgentId: agent.id,
          assigneeUserId: null,
          requestDepth: Math.max(0, parentIssue.requestDepth ?? 0) + 1,
          billingCode: parentIssue.billingCode,
          assigneeAdapterOverrides: null,
          createdByAgentId: input.requestedByAgentId,
          createdByUserId: input.requestedByUserId,
        });
        created.push({
          id: child.id,
          identifier: child.identifier,
          assigneeAgentId: child.assigneeAgentId,
        });
        void heartbeat
          .wakeup(agent.id, {
            source: "automation",
            triggerDetail: "system",
            reason: "critical_goal_fanout",
            payload: { issueId: child.id, parentIssueId: parentIssue.id },
            requestedByActorType: input.requestedByActorType,
            requestedByActorId: input.requestedByActorId,
            contextSnapshot: {
              issueId: child.id,
              parentIssueId: parentIssue.id,
              source: "workflow_automation.fanout",
            },
          })
          .catch(() => {});
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : typeof err === "string" ? err : "unknown";
        if (errorMessage.toLowerCase().includes("duplicate issue exists")) {
          duplicates.push(agent.name);
        } else {
          skipped.push(agent.name);
        }
      }
    }

    await logActivity(db, {
      companyId: input.companyId,
      actorType: input.requestedByActorType,
      actorId: input.requestedByActorId,
      agentId: input.requestedByAgentId,
      action: "issue.fanout_critical",
      entityType: "issue",
      entityId: parentIssue.id,
      details: {
        createdCount: created.length,
        duplicateCount: duplicates.length,
        skippedCount: skipped.length,
        parentIssueId: parentIssue.id,
      },
    });

    return { created, duplicates, skipped };
  }

  async function escalateOverdueBlocked(now: Date) {
    const cutoff = new Date(now.getTime() - BLOCKED_SLA_HOURS * 60 * 60 * 1000);
    const overdue = await db
      .select({
        id: issues.id,
        identifier: issues.identifier,
        companyId: issues.companyId,
        title: issues.title,
        updatedAt: issues.updatedAt,
        assigneeAgentId: issues.assigneeAgentId,
        assigneeName: agents.name,
        reportsTo: agents.reportsTo,
      })
      .from(issues)
      .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
      .where(
        and(
          eq(issues.status, "blocked"),
          isNull(issues.hiddenAt),
          lte(issues.updatedAt, cutoff),
        ),
      )
      .orderBy(asc(issues.updatedAt))
      .limit(200);

    let escalated = 0;
    for (const row of overdue) {
      if (!row.assigneeAgentId || !row.reportsTo || row.reportsTo === row.assigneeAgentId) continue;

      const manager = await db
        .select({ id: agents.id, name: agents.name, status: agents.status })
        .from(agents)
        .where(eq(agents.id, row.reportsTo))
        .then((rows) => rows[0] ?? null);
      if (!manager) continue;
      if (manager.status === "terminated" || manager.status === "pending_approval") continue;

      const updated = await issuesSvc.update(
        row.id,
        {
          assigneeAgentId: manager.id,
          assigneeUserId: null,
          status: "todo",
        },
        { skipAssignmentTemplateValidation: true },
      );
      if (!updated) continue;

      const body = [
        "## SLA Escalation",
        "",
        `Blocked for over ${BLOCKED_SLA_HOURS}h, escalated to ${manager.name}.`,
        "",
        `- Previous owner: ${row.assigneeName}`,
        `- New owner: ${manager.name}`,
        `- Last update: ${row.updatedAt.toISOString()}`,
        "",
        `<!-- paperclip:auto-blocked-sla:${now.toISOString()} -->`,
      ].join("\n");
      await issuesSvc.addComment(row.id, body, {});
      await logActivity(db, {
        companyId: row.companyId,
        actorType: AUTO_ACTOR_TYPE,
        actorId: AUTO_ACTOR_ID,
        action: "issue.blocked_sla_escalated",
        entityType: "issue",
        entityId: row.id,
        details: {
          fromAgentId: row.assigneeAgentId,
          toAgentId: manager.id,
          thresholdHours: BLOCKED_SLA_HOURS,
        },
      });

      escalated += 1;
      void heartbeat
        .wakeup(manager.id, {
          source: "automation",
          triggerDetail: "system",
          reason: "blocked_sla_escalated",
          payload: { issueId: row.id },
          requestedByActorType: AUTO_ACTOR_TYPE,
          requestedByActorId: AUTO_ACTOR_ID,
          contextSnapshot: {
            issueId: row.id,
            source: "workflow_automation.blocked_sla",
          },
        })
        .catch(() => {});
    }

    return escalated;
  }

  async function postDailyRollups(now: Date, dayKey: string) {
    const marker = `<!-- paperclip:auto-rollup:${dayKey} -->`;
    const parents = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          isNull(issues.parentId),
          isNull(issues.hiddenAt),
          inArray(issues.priority, [...DAILY_ROLLUP_PARENT_PRIORITIES]),
          inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
        ),
      )
      .orderBy(desc(issues.updatedAt))
      .limit(500);

    let posted = 0;
    for (const parent of parents) {
      const exists = await db
        .select({ id: issueComments.id })
        .from(issueComments)
        .where(
          and(
            eq(issueComments.issueId, parent.id),
            sql`${issueComments.body} like ${`%${marker}%`}`,
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (exists) continue;

      const children = await db
        .select({
          id: issues.id,
          identifier: issues.identifier,
          status: issues.status,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          updatedAt: issues.updatedAt,
        })
        .from(issues)
        .where(and(eq(issues.parentId, parent.id), isNull(issues.hiddenAt)))
        .orderBy(desc(issues.updatedAt));
      if (children.length === 0) continue;

      const total = children.length;
      const done = children.filter((child) => child.status === "done").length;
      const blocked = children.filter((child) => child.status === "blocked").length;
      const missingOwners = children.filter((child) => !child.assigneeAgentId && !child.assigneeUserId).length;
      const staleCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      const stale = children.filter(
        (child) =>
          child.updatedAt < staleCutoff &&
          child.status !== "done" &&
          child.status !== "cancelled",
      ).length;
      const completion = Math.round((done / total) * 100);
      const blockedItems = children
        .filter((child) => child.status === "blocked")
        .slice(0, 3)
        .map((child) => `[${child.identifier ?? child.id}](/issues/${child.identifier ?? child.id})`)
        .join(", ");

      const body = [
        `## Daily Rollup (${dayKey})`,
        "",
        `- Progress: ${done}/${total} (${completion}%)`,
        `- Blocked: ${blocked}`,
        `- Missing owners: ${missingOwners}`,
        `- Stale (>24h without update): ${stale}`,
        `- Blocked items: ${blockedItems || "none"}`,
        "",
        marker,
      ].join("\n");
      await issuesSvc.addComment(parent.id, body, {});
      await logActivity(db, {
        companyId: parent.companyId,
        actorType: AUTO_ACTOR_TYPE,
        actorId: AUTO_ACTOR_ID,
        action: "issue.daily_rollup_posted",
        entityType: "issue",
        entityId: parent.id,
        details: {
          date: dayKey,
          total,
          done,
          blocked,
          missingOwners,
          stale,
        },
      });
      posted += 1;

      if (parent.assigneeAgentId) {
        void heartbeat
          .wakeup(parent.assigneeAgentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "daily_parent_rollup_posted",
            payload: { issueId: parent.id, date: dayKey },
            requestedByActorType: AUTO_ACTOR_TYPE,
            requestedByActorId: AUTO_ACTOR_ID,
            contextSnapshot: {
              issueId: parent.id,
              date: dayKey,
              source: "workflow_automation.daily_rollup",
            },
          })
          .catch(() => {});
      }
    }

    return posted;
  }

  return {
    async tick(now = new Date()) {
      const blockedSweepDue = now.getTime() - lastBlockedSweepAt >= BLOCKED_SWEEP_INTERVAL_MS;
      const dayKey = localDayKey(now);
      const shouldPostDailyRollup =
        localHour(now) >= DAILY_ROLLUP_HOUR_LOCAL && lastRollupDay !== dayKey;

      let blockedEscalations = 0;
      let dailyRollups = 0;

      if (blockedSweepDue) {
        blockedEscalations = await escalateOverdueBlocked(now);
        lastBlockedSweepAt = now.getTime();
      }
      if (shouldPostDailyRollup) {
        dailyRollups = await postDailyRollups(now, dayKey);
        lastRollupDay = dayKey;
      }

      return {
        blockedEscalations,
        dailyRollups,
      };
    },
    fanoutCritical,
  };
}
