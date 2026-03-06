import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, goals, issueComments, issues } from "@paperclipai/db";
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
const ALERTABLE_AGENT_STATUSES = ["active", "idle", "running", "paused"];
const AUTO_ACTOR_ID = "workflow-automation";
const AUTO_ACTOR_TYPE = "system" as const;
const LOCAL_TIMEZONE =
  process.env.PAPERCLIP_AUTOMATION_TIMEZONE ||
  process.env.TZ ||
  Intl.DateTimeFormat().resolvedOptions().timeZone ||
  "UTC";
const QUEUE_AGING_QUEUED_HOURS = Math.max(
  1,
  Number(process.env.PAPERCLIP_QUEUE_AGING_QUEUED_HOURS) || 6,
);
const QUEUE_AGING_BLOCKED_HOURS = Math.max(
  1,
  Number(process.env.PAPERCLIP_QUEUE_AGING_BLOCKED_HOURS) || BLOCKED_SLA_HOURS,
);
const QUEUE_AGING_BLOCKER_LOOP_WINDOW_HOURS = Math.max(
  1,
  Number(process.env.PAPERCLIP_QUEUE_AGING_BLOCKER_LOOP_WINDOW_HOURS) || 24,
);
const QUEUE_AGING_BLOCKER_LOOP_THRESHOLD = Math.max(
  2,
  Number(process.env.PAPERCLIP_QUEUE_AGING_BLOCKER_LOOP_THRESHOLD) || 3,
);
const QUEUE_AGING_ALERT_COOLDOWN_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.PAPERCLIP_QUEUE_AGING_ALERT_COOLDOWN_MS) || 4 * 60 * 60 * 1000,
);
const QUEUE_AGING_FROZEN_DIGEST_COOLDOWN_MS = Math.max(
  30 * 60 * 1000,
  Number(process.env.PAPERCLIP_QUEUE_AGING_FROZEN_DIGEST_COOLDOWN_MS) || 24 * 60 * 60 * 1000,
);
const BOARD_FREEZE_CONTEXT_REGEX =
  /\b(board directive|board instruction|board policy|board pause|board reactivation|paused by board)\b/i;
const BOARD_FREEZE_DIRECTIVE_REGEX =
  /\b(keep (?:this task )?frozen|task frozen|frozen for now|pause directive|paused by board|resume only after explicit board reactivation|no execution work will resume until explicit board reactivation|on hold pending explicit board reactivation)\b/i;
const BOARD_UNFREEZE_DIRECTIVE_REGEX =
  /\b(pause lifted|freeze lifted|board reactivated|board reactivation approved|resume work now|work resumed|resume execution now|unpause(?:d)?|reactivation approved)\b/i;

type QueueAgingReason = "queued_age" | "blocked_age" | "blocker_loop";
type QueueAgingFreezeSignal = {
  issueId: string;
  body: string;
  authorUserId: string | null;
  createdAt: Date;
};
type QueueAgingFreezeState = {
  isFrozen: boolean;
  lastFreezeAt: Date | null;
  lastUnfreezeAt: Date | null;
};

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

function formatQueueAgingReasonLine(input: {
  reason: QueueAgingReason;
  ageMinutes: number;
  blockedTransitions: number;
}) {
  if (input.reason === "queued_age") {
    return `- queued age: ${input.ageMinutes} minute(s) (threshold ${QUEUE_AGING_QUEUED_HOURS}h)`;
  }
  if (input.reason === "blocked_age") {
    return `- blocked age: ${input.ageMinutes} minute(s) (threshold ${QUEUE_AGING_BLOCKED_HOURS}h)`;
  }
  return `- blocker loops: ${input.blockedTransitions} transition(s) to blocked in ${QUEUE_AGING_BLOCKER_LOOP_WINDOW_HOURS}h (threshold ${QUEUE_AGING_BLOCKER_LOOP_THRESHOLD})`;
}

function isAlertableAgentStatus(status: string) {
  return ALERTABLE_AGENT_STATUSES.includes(status);
}

function hasBoardFreezeContext(input: { body: string; authorUserId: string | null }) {
  return Boolean(input.authorUserId) || BOARD_FREEZE_CONTEXT_REGEX.test(input.body);
}

export function isBoardFreezeDirectiveComment(input: { body: string; authorUserId: string | null }) {
  if (!hasBoardFreezeContext(input)) return false;
  return BOARD_FREEZE_DIRECTIVE_REGEX.test(input.body);
}

export function isBoardUnfreezeDirectiveComment(input: { body: string; authorUserId: string | null }) {
  if (!hasBoardFreezeContext(input)) return false;
  if (/resume only after explicit board reactivation/i.test(input.body)) {
    return false;
  }
  return BOARD_UNFREEZE_DIRECTIVE_REGEX.test(input.body);
}

export function resolveBoardFreezeState(comments: QueueAgingFreezeSignal[]) {
  const freezeStateByIssue = new Map<string, QueueAgingFreezeState>();
  const orderedComments = [...comments].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const comment of orderedComments) {
    const state = freezeStateByIssue.get(comment.issueId) ?? {
      isFrozen: false,
      lastFreezeAt: null,
      lastUnfreezeAt: null,
    };
    if (isBoardFreezeDirectiveComment(comment)) {
      state.isFrozen = true;
      state.lastFreezeAt = comment.createdAt;
    } else if (isBoardUnfreezeDirectiveComment(comment)) {
      state.isFrozen = false;
      state.lastUnfreezeAt = comment.createdAt;
    }
    freezeStateByIssue.set(comment.issueId, state);
  }

  return freezeStateByIssue;
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

  async function alertQueueAging(now: Date) {
    const queuedCutoff = new Date(now.getTime() - QUEUE_AGING_QUEUED_HOURS * 60 * 60 * 1000);
    const blockedCutoff = new Date(now.getTime() - QUEUE_AGING_BLOCKED_HOURS * 60 * 60 * 1000);
    const blockerLoopSince = new Date(
      now.getTime() - QUEUE_AGING_BLOCKER_LOOP_WINDOW_HOURS * 60 * 60 * 1000,
    );

    const queuedAged = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        projectId: issues.projectId,
        updatedAt: issues.updatedAt,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          isNull(issues.hiddenAt),
          inArray(issues.status, ["backlog", "todo"]),
          lte(issues.updatedAt, queuedCutoff),
        ),
      )
      .orderBy(asc(issues.updatedAt))
      .limit(200);

    const blockedAged = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        identifier: issues.identifier,
        title: issues.title,
        status: issues.status,
        priority: issues.priority,
        projectId: issues.projectId,
        updatedAt: issues.updatedAt,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          isNull(issues.hiddenAt),
          eq(issues.status, "blocked"),
          lte(issues.updatedAt, blockedCutoff),
        ),
      )
      .orderBy(asc(issues.updatedAt))
      .limit(200);

    const blockerLoopRows = await db
      .select({
        issueId: activityLog.entityId,
        blockedTransitions: sql<number>`count(*)::int`,
      })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.entityType, "issue"),
          eq(activityLog.action, "issue.updated"),
          gte(activityLog.createdAt, blockerLoopSince),
          sql`coalesce(${activityLog.details} ->> 'status', '') = 'blocked'`,
        ),
      )
      .groupBy(activityLog.entityId)
      .having(sql`count(*) >= ${QUEUE_AGING_BLOCKER_LOOP_THRESHOLD}`)
      .orderBy(desc(sql`count(*)`))
      .limit(200);

    const loopIssueIds = blockerLoopRows.map((row) => row.issueId);
    const blockerLoopIssues =
      loopIssueIds.length > 0
        ? await db
          .select({
            id: issues.id,
            companyId: issues.companyId,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            projectId: issues.projectId,
            updatedAt: issues.updatedAt,
            assigneeAgentId: issues.assigneeAgentId,
          })
          .from(issues)
          .where(
            and(
              isNull(issues.hiddenAt),
              inArray(issues.status, ["backlog", "todo", "in_progress", "in_review", "blocked"]),
              inArray(issues.id, loopIssueIds),
            ),
          )
          .limit(200)
        : [];

    const candidates = new Map<
      string,
      {
        id: string;
        companyId: string;
        identifier: string | null;
        title: string;
        status: string;
        priority: string;
        projectId: string | null;
        updatedAt: Date;
        assigneeAgentId: string | null;
        reasons: Set<QueueAgingReason>;
        blockedTransitions: number;
      }
    >();

    const appendCandidate = (
      issue: {
        id: string;
        companyId: string;
        identifier: string | null;
        title: string;
        status: string;
        priority: string;
        projectId: string | null;
        updatedAt: Date;
        assigneeAgentId: string | null;
      },
      reason: QueueAgingReason,
      blockedTransitions?: number,
    ) => {
      const existing = candidates.get(issue.id);
      if (!existing) {
        candidates.set(issue.id, {
          ...issue,
          reasons: new Set([reason]),
          blockedTransitions: blockedTransitions ?? 0,
        });
        return;
      }
      existing.reasons.add(reason);
      existing.blockedTransitions = Math.max(existing.blockedTransitions, blockedTransitions ?? 0);
    };

    for (const row of queuedAged) appendCandidate(row, "queued_age");
    for (const row of blockedAged) appendCandidate(row, "blocked_age");
    const blockerLoopByIssue = new Map(
      blockerLoopRows.map((row) => [row.issueId, Number(row.blockedTransitions ?? 0)]),
    );
    for (const row of blockerLoopIssues) {
      appendCandidate(row, "blocker_loop", blockerLoopByIssue.get(row.id) ?? 0);
    }

    if (candidates.size === 0) return 0;

    const candidateIssueIds = [...candidates.keys()];
    const freezeSignalComments = await db
      .select({
        issueId: issueComments.issueId,
        body: issueComments.body,
        authorUserId: issueComments.authorUserId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(
        and(
          inArray(issueComments.issueId, candidateIssueIds),
          sql`(
            lower(${issueComments.body}) like '%frozen%'
            or lower(${issueComments.body}) like '%freeze%'
            or lower(${issueComments.body}) like '%pause%'
            or lower(${issueComments.body}) like '%paused%'
            or lower(${issueComments.body}) like '%reactivat%'
            or lower(${issueComments.body}) like '%resume%'
          )`,
        ),
      )
      .orderBy(asc(issueComments.createdAt));
    const freezeStateByIssue = resolveBoardFreezeState(freezeSignalComments);

    const alertCooldownSince = new Date(now.getTime() - QUEUE_AGING_ALERT_COOLDOWN_MS);
    const recentAlerts = await db
      .select({
        issueId: issueComments.issueId,
        body: issueComments.body,
      })
      .from(issueComments)
      .where(
        and(
          inArray(issueComments.issueId, candidateIssueIds),
          gte(issueComments.createdAt, alertCooldownSince),
          sql`${issueComments.body} like '%paperclip:auto-queue-aging:%'`,
        ),
      );

    const recentReasonAlerts = new Set<string>();
    for (const comment of recentAlerts) {
      const matches = comment.body.matchAll(/paperclip:auto-queue-aging:([a-z_]+):/g);
      for (const match of matches) {
        const reason = (match[1] ?? "").trim();
        if (!reason) continue;
        recentReasonAlerts.add(`${comment.issueId}:${reason}`);
      }
    }

    const frozenDigestCooldownSince = new Date(
      now.getTime() - QUEUE_AGING_FROZEN_DIGEST_COOLDOWN_MS,
    );
    const recentFrozenDigests = await db
      .select({
        issueId: issueComments.issueId,
      })
      .from(issueComments)
      .where(
        and(
          inArray(issueComments.issueId, candidateIssueIds),
          gte(issueComments.createdAt, frozenDigestCooldownSince),
          sql`${issueComments.body} like '%paperclip:auto-queue-aging-frozen:%'`,
        ),
      );
    const recentFrozenDigestIssues = new Set(recentFrozenDigests.map((row) => row.issueId));

    const agentRows = await db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        status: agents.status,
        reportsTo: agents.reportsTo,
      })
      .from(agents);
    const agentById = new Map(agentRows.map((row) => [row.id, row]));

    let alerted = 0;
    for (const candidate of candidates.values()) {
      const reasons = [...candidate.reasons].filter(
        (reason) => !recentReasonAlerts.has(`${candidate.id}:${reason}`),
      );
      if (reasons.length === 0) continue;

      const ageMinutes = Math.max(
        1,
        Math.floor((now.getTime() - candidate.updatedAt.getTime()) / 60_000),
      );
      const reasonLines = reasons.map((reason) =>
        formatQueueAgingReasonLine({
          reason,
          ageMinutes,
          blockedTransitions: candidate.blockedTransitions,
        }),
      );

      const freezeState = freezeStateByIssue.get(candidate.id);
      if (freezeState?.isFrozen) {
        if (recentFrozenDigestIssues.has(candidate.id)) continue;

        const markers = [
          `<!-- paperclip:auto-queue-aging-frozen:${now.toISOString()} -->`,
          ...reasons.map(
            (reason) =>
              `<!-- paperclip:auto-queue-aging-frozen-reason:${reason}:${now.toISOString()} -->`,
          ),
        ];
        const body = [
          "## Queue Aging Digest (Frozen Lane)",
          "Queue-health thresholds were met, but wakeups were suppressed due to explicit board freeze context.",
          "",
          ...reasonLines,
          "- Wakeups: suppressed for this cycle (board-frozen lane)",
          `- Last freeze signal: ${freezeState.lastFreezeAt?.toISOString() ?? "unknown"}`,
          "- Resume condition: explicit board reactivation",
          "",
          ...markers,
        ].join("\n");

        const comment = await issuesSvc.addComment(candidate.id, body, {});
        await logActivity(db, {
          companyId: candidate.companyId,
          actorType: AUTO_ACTOR_TYPE,
          actorId: AUTO_ACTOR_ID,
          action: "issue.queue_aging_frozen_digest_posted",
          entityType: "issue",
          entityId: candidate.id,
          details: {
            issueIdentifier: candidate.identifier,
            reasons,
            blockedTransitions: candidate.blockedTransitions,
            ageMinutes,
            commentId: comment.id,
            suppressedWakeups: true,
            freezeSignalAt: freezeState.lastFreezeAt?.toISOString() ?? null,
          },
        });
        alerted += 1;
        continue;
      }

      const owner =
        candidate.assigneeAgentId != null ? (agentById.get(candidate.assigneeAgentId) ?? null) : null;
      const ownerTarget =
        owner && isAlertableAgentStatus(owner.status) ? owner : null;
      const manager =
        ownerTarget?.reportsTo && ownerTarget.reportsTo !== ownerTarget.id
          ? (agentById.get(ownerTarget.reportsTo) ?? null)
          : null;
      const managerTarget =
        manager && isAlertableAgentStatus(manager.status) ? manager : null;

      const severe = reasons.includes("blocked_age") || reasons.includes("blocker_loop");
      const wakeTargets = new Map<string, "owner" | "fallback_escalation">();
      if (ownerTarget) {
        wakeTargets.set(ownerTarget.id, "owner");
      }
      if (managerTarget && (!ownerTarget || severe)) {
        wakeTargets.set(managerTarget.id, "fallback_escalation");
      }

      const balancingRecommendation =
        severe
          ? await issuesSvc.selectBalancedAssignee({
              companyId: candidate.companyId,
              priority: candidate.priority,
              targetStatus: candidate.status,
              projectId: candidate.projectId,
              excludeAgentIds: ownerTarget?.id ? [ownerTarget.id] : [],
            })
          : null;
      const recommendationLine =
        balancingRecommendation &&
        balancingRecommendation.topCandidates.length > 0 &&
        balancingRecommendation.selectedAgentId
          ? `- Load-aware recommendation: ${balancingRecommendation.selectedAgentName ?? balancingRecommendation.selectedAgentId} (${balancingRecommendation.mode}, ${balancingRecommendation.candidatesEvaluated} candidate(s))`
          : null;

      const markers = reasons.map(
        (reason) => `<!-- paperclip:auto-queue-aging:${reason}:${now.toISOString()} -->`,
      );

      const body = [
        "## Queue Aging Alert",
        "Workflow automation detected queue-health threshold breach.",
        "",
        ...reasonLines,
        `- Owner: ${ownerTarget?.name ?? "unassigned/unknown"}`,
        `- Fallback escalation: ${managerTarget?.name ?? "none"}`,
        recommendationLine,
        "",
        ...markers,
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n");

      const comment = await issuesSvc.addComment(candidate.id, body, {});
      await logActivity(db, {
        companyId: candidate.companyId,
        actorType: AUTO_ACTOR_TYPE,
        actorId: AUTO_ACTOR_ID,
        action: "issue.queue_aging_alerted",
        entityType: "issue",
        entityId: candidate.id,
        details: {
          issueIdentifier: candidate.identifier,
          reasons,
          ownerAgentId: ownerTarget?.id ?? null,
          fallbackAgentId: managerTarget?.id ?? null,
          wakeTargets: [...wakeTargets.keys()],
          blockedTransitions: candidate.blockedTransitions,
          ageMinutes,
          commentId: comment.id,
          loadAwareRecommendation:
            balancingRecommendation && balancingRecommendation.topCandidates.length > 0
              ? {
                  mode: balancingRecommendation.mode,
                  selectedAgentId: balancingRecommendation.selectedAgentId,
                  selectedAgentName: balancingRecommendation.selectedAgentName,
                  candidatesEvaluated: balancingRecommendation.candidatesEvaluated,
                  topCandidates: balancingRecommendation.topCandidates,
                }
              : undefined,
        },
      });

      for (const [agentId, target] of wakeTargets.entries()) {
        void heartbeat
          .wakeup(agentId, {
            source: "automation",
            triggerDetail: "system",
            reason: "queue_aging_alert",
            payload: {
              issueId: candidate.id,
              issueIdentifier: candidate.identifier ?? null,
              reasons,
              target,
              alertCommentId: comment.id,
            },
            requestedByActorType: AUTO_ACTOR_TYPE,
            requestedByActorId: AUTO_ACTOR_ID,
            contextSnapshot: {
              issueId: candidate.id,
              issueIdentifier: candidate.identifier ?? null,
              reasons,
              target,
              source: "workflow_automation.queue_aging",
            },
          })
          .catch(() => {});
      }

      alerted += 1;
    }

    return alerted;
  }

  return {
    async tick(now = new Date()) {
      const blockedSweepDue = now.getTime() - lastBlockedSweepAt >= BLOCKED_SWEEP_INTERVAL_MS;
      const dayKey = localDayKey(now);
      const shouldPostDailyRollup =
        localHour(now) >= DAILY_ROLLUP_HOUR_LOCAL && lastRollupDay !== dayKey;

      let blockedEscalations = 0;
      let dailyRollups = 0;
      let queueAgingAlerts = 0;

      if (blockedSweepDue) {
        blockedEscalations = await escalateOverdueBlocked(now);
        queueAgingAlerts = await alertQueueAging(now);
        lastBlockedSweepAt = now.getTime();
      }
      if (shouldPostDailyRollup) {
        dailyRollups = await postDailyRollups(now, dayKey);
        lastRollupDay = dayKey;
      }

      return {
        blockedEscalations,
        queueAgingAlerts,
        dailyRollups,
      };
    },
    fanoutCritical,
  };
}
