import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, agents, heartbeatRuns, issues } from "@paperclipai/db";
import type {
  CompanyScorecard,
  ScorecardActivityItem,
  ScorecardAttentionItem,
  ScorecardCounters,
  ScorecardPulse,
} from "@paperclipai/shared";

const ATTENTION_LIMIT = 10;
const ACTIVITY_LIMIT = 20;
const AMBER_ATTENTION_THRESHOLD = 3;
const IN_REVIEW_STALE_HOURS = 24;
const STALLED_DAYS = 7;
const DONE_WINDOW_DAYS = 7;
const RUN_WINDOW_HOURS = 24;

type ActivityKind = ScorecardActivityItem["kind"];

const ACTION_TO_KIND: Record<string, ActivityKind> = {
  "issue.comment_added": "comment",
  "heartbeat.invoked": "run_started",
  "heartbeat.cancelled": "run_finished",
};

function classifyAction(action: string): ActivityKind | null {
  const mapped = ACTION_TO_KIND[action];
  if (mapped) return mapped;
  if (action.startsWith("issue.")) return "status_change";
  return null;
}

function emptyCounters(): ScorecardCounters {
  return {
    issues: { todo: 0, inProgress: 0, inReview: 0, blocked: 0, done7d: 0 },
    agents: { active: 0, idle: 0, paused: 0 },
    runs24h: { succeeded: 0, failed: 0, other: 0 },
  };
}

export function scorecardService(db: Db) {
  return {
    get: async (companyId: string, now: Date = new Date()): Promise<CompanyScorecard> => {
      const runWindowStart = new Date(now.getTime() - RUN_WINDOW_HOURS * 60 * 60 * 1000);
      const doneWindowStart = new Date(now.getTime() - DONE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const inReviewStaleBefore = new Date(now.getTime() - IN_REVIEW_STALE_HOURS * 60 * 60 * 1000);
      const stalledBefore = new Date(now.getTime() - STALLED_DAYS * 24 * 60 * 60 * 1000);

      const [
        issueStatusRows,
        doneRecentRow,
        agentRows,
        runRows,
        attentionRows,
        activityRows,
      ] = await Promise.all([
        db
          .select({ status: issues.status, count: sql<number>`count(*)` })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), isNull(issues.hiddenAt)))
          .groupBy(issues.status),
        db
          .select({ count: sql<number>`count(*)` })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              eq(issues.status, "done"),
              gte(issues.completedAt, doneWindowStart),
            ),
          )
          .then((rows) => Number(rows[0]?.count ?? 0)),
        db
          .select({ status: agents.status, count: sql<number>`count(*)` })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .groupBy(agents.status),
        db
          .select({ status: heartbeatRuns.status, count: sql<number>`count(*)` })
          .from(heartbeatRuns)
          .where(
            and(eq(heartbeatRuns.companyId, companyId), gte(heartbeatRuns.createdAt, runWindowStart)),
          )
          .groupBy(heartbeatRuns.status),
        db
          .select({
            id: issues.id,
            identifier: issues.identifier,
            title: issues.title,
            status: issues.status,
            priority: issues.priority,
            assigneeAgentId: issues.assigneeAgentId,
            updatedAt: issues.updatedAt,
          })
          .from(issues)
          .where(
            and(
              eq(issues.companyId, companyId),
              isNull(issues.hiddenAt),
              or(
                eq(issues.status, "blocked"),
                and(eq(issues.status, "in_review"), lt(issues.updatedAt, inReviewStaleBefore)),
                and(
                  inArray(issues.status, ["todo", "in_progress"]),
                  lt(issues.updatedAt, stalledBefore),
                ),
              ),
            ),
          )
          .orderBy(desc(issues.updatedAt))
          .limit(ATTENTION_LIMIT),
        db
          .select({
            action: activityLog.action,
            entityType: activityLog.entityType,
            entityId: activityLog.entityId,
            agentId: activityLog.agentId,
            agentName: agents.name,
            createdAt: activityLog.createdAt,
          })
          .from(activityLog)
          .leftJoin(agents, eq(agents.id, activityLog.agentId))
          .where(eq(activityLog.companyId, companyId))
          .orderBy(desc(activityLog.createdAt))
          .limit(ACTIVITY_LIMIT * 2),
      ]);

      const counters = emptyCounters();
      counters.issues.done7d = doneRecentRow;

      for (const row of issueStatusRows) {
        const count = Number(row.count);
        switch (row.status) {
          case "todo":
            counters.issues.todo += count;
            break;
          case "in_progress":
            counters.issues.inProgress += count;
            break;
          case "in_review":
            counters.issues.inReview += count;
            break;
          case "blocked":
            counters.issues.blocked += count;
            break;
        }
      }

      for (const row of agentRows) {
        const count = Number(row.count);
        if (row.status === "active" || row.status === "running") counters.agents.active += count;
        else if (row.status === "idle") counters.agents.idle += count;
        else if (row.status === "paused" || row.status === "error") counters.agents.paused += count;
      }

      for (const row of runRows) {
        const count = Number(row.count);
        if (row.status === "succeeded") counters.runs24h.succeeded += count;
        else if (row.status === "failed" || row.status === "timed_out") counters.runs24h.failed += count;
        else counters.runs24h.other += count;
      }

      const attention: ScorecardAttentionItem[] = attentionRows.map((row) => ({
        issueId: row.id,
        identifier: row.identifier ?? row.id,
        title: row.title,
        status: row.status,
        priority: row.priority,
        assigneeAgentId: row.assigneeAgentId,
        updatedAt: row.updatedAt.toISOString(),
        reason:
          row.status === "blocked"
            ? "blocked"
            : row.status === "in_review"
              ? "in_review_waiting"
              : "stalled",
      }));

      const issueEntityIds = Array.from(
        new Set(
          activityRows
            .filter((row) => row.entityType === "issue")
            .map((row) => row.entityId),
        ),
      );
      const issueLookup = new Map<string, { id: string; identifier: string | null }>();
      if (issueEntityIds.length > 0) {
        const rows = await db
          .select({ id: issues.id, identifier: issues.identifier })
          .from(issues)
          .where(and(eq(issues.companyId, companyId), inArray(issues.id, issueEntityIds)));
        for (const row of rows) {
          issueLookup.set(row.id, row);
        }
      }

      const activity: ScorecardActivityItem[] = [];
      for (const row of activityRows) {
        if (activity.length >= ACTIVITY_LIMIT) break;
        const kind = classifyAction(row.action);
        if (!kind) continue;
        const issue = row.entityType === "issue" ? issueLookup.get(row.entityId) ?? null : null;
        activity.push({
          kind,
          label: row.action,
          issueId: issue?.id ?? null,
          issueIdentifier: issue?.identifier ?? null,
          agentId: row.agentId ?? null,
          agentName: row.agentName ?? null,
          occurredAt: row.createdAt.toISOString(),
        });
      }

      const pulse = derivePulse(counters, attention, activity);

      return {
        companyId,
        pulse,
        counters,
        attention,
        activity,
        computedAt: now.toISOString(),
      };
    },
  };
}

function derivePulse(
  counters: ScorecardCounters,
  attention: ScorecardAttentionItem[],
  activity: ScorecardActivityItem[],
): ScorecardPulse {
  if (counters.issues.blocked > 0 || counters.runs24h.failed > 0) return "red";
  if (attention.length >= AMBER_ATTENTION_THRESHOLD) return "amber";
  const totalRuns = counters.runs24h.succeeded + counters.runs24h.failed + counters.runs24h.other;
  if (totalRuns === 0 && activity.length === 0) return "grey";
  return "green";
}
