import { and, asc, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueComments, issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { logActivity } from "./activity-log.js";
import type { heartbeatService } from "./heartbeat.js";

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function priorityRank(priority: string | null): number {
  return PRIORITY_ORDER[priority ?? "medium"] ?? 2;
}

export interface EligibleBacklogIssue {
  id: string;
  assigneeAgentId: string;
  updatedAt: Date;
  priority: string | null;
}

// Pure: order oldest-first, then by priority within same age; apply per-agent cap.
export function selectBacklogWakeTargets(
  eligible: EligibleBacklogIssue[],
  perAgentDailyCap: number,
): EligibleBacklogIssue[] {
  const sorted = [...eligible].sort((a, b) => {
    const ageDiff = a.updatedAt.getTime() - b.updatedAt.getTime();
    if (ageDiff !== 0) return ageDiff;
    return priorityRank(a.priority) - priorityRank(b.priority);
  });

  const wokenPerAgent = new Map<string, number>();
  const selected: EligibleBacklogIssue[] = [];
  for (const issue of sorted) {
    const count = wokenPerAgent.get(issue.assigneeAgentId) ?? 0;
    if (count >= perAgentDailyCap) continue;
    selected.push(issue);
    wokenPerAgent.set(issue.assigneeAgentId, count + 1);
  }
  return selected;
}

export interface BacklogStaleSweepOptions {
  ageThresholdHours: number;
  commentInactivityThresholdHours: number;
  perAgentDailyCap: number;
  // When set, scope the sweep to a single company. Manual route invocations
  // always supply this from the path param. The daily cron omits it to sweep
  // every company in one pass (callers wanting per-tenant isolation should set it).
  companyId?: string;
}

export async function sweepBacklogStale(
  db: Db,
  heartbeat: ReturnType<typeof heartbeatService>,
  opts: BacklogStaleSweepOptions = {
    ageThresholdHours: 72,
    commentInactivityThresholdHours: 72,
    perAgentDailyCap: 5,
  },
): Promise<{ scanned: number; woken: number }> {
  const ageCutoff = new Date(Date.now() - opts.ageThresholdHours * 60 * 60 * 1000);
  const commentCutoff = new Date(Date.now() - opts.commentInactivityThresholdHours * 60 * 60 * 1000);

  const whereClauses = [
    eq(issues.status, "backlog"),
    isNotNull(issues.assigneeAgentId),
    lt(issues.updatedAt, ageCutoff),
  ];
  if (opts.companyId) {
    whereClauses.push(eq(issues.companyId, opts.companyId));
  }

  // Find issues that are backlog, stale, assigned, and not opted out
  const candidates = await db
    .select({
      id: issues.id,
      companyId: issues.companyId,
      assigneeAgentId: issues.assigneeAgentId,
      updatedAt: issues.updatedAt,
      priority: issues.priority,
      backlogSweepConfig: issues.backlogSweepConfig,
    })
    .from(issues)
    .where(and(...whereClauses))
    .orderBy(asc(issues.updatedAt));

  if (candidates.length === 0) return { scanned: 0, woken: 0 };

  // First-pass filter: respect per-issue backlogSweepConfig and the optional
  // per-issue age override. This narrows the set before the single comment-
  // activity batch lookup below.
  const ageEligible: typeof candidates = [];
  for (const candidate of candidates) {
    const config = candidate.backlogSweepConfig as { ageThresholdHours?: number; disabled?: boolean } | null;
    if (config?.disabled) continue;

    const effectiveAgeCutoff = config?.ageThresholdHours
      ? new Date(Date.now() - config.ageThresholdHours * 60 * 60 * 1000)
      : ageCutoff;
    if (candidate.updatedAt >= effectiveAgeCutoff) continue;

    ageEligible.push(candidate);
  }

  // Batch the comment-activity lookup: one query for every candidate id at
  // once, then filter locally. Replaces the per-candidate SELECT that made
  // this O(N) database round-trips.
  let activeIssueIds = new Set<string>();
  if (ageEligible.length > 0) {
    const rows = await db
      .selectDistinct({ issueId: issueComments.issueId })
      .from(issueComments)
      .where(and(
        inArray(issueComments.issueId, ageEligible.map((c) => c.id)),
        gte(issueComments.createdAt, commentCutoff),
      ));
    activeIssueIds = new Set(rows.map((r) => r.issueId));
  }

  const eligible = ageEligible.filter((c) => !activeIssueIds.has(c.id));

  if (eligible.length === 0) return { scanned: candidates.length, woken: 0 };

  const targets = selectBacklogWakeTargets(
    eligible.map((c) => ({
      id: c.id,
      assigneeAgentId: c.assigneeAgentId!,
      updatedAt: c.updatedAt,
      priority: c.priority,
    })),
    opts.perAgentDailyCap,
  );

  let woken = 0;

  const eligibleById = new Map(eligible.map((c) => [c.id, c]));
  for (const target of targets) {
    const issue = eligibleById.get(target.id)!;
    const agentId = target.assigneeAgentId;

    const ageDays = Math.floor((Date.now() - issue.updatedAt.getTime()) / (24 * 60 * 60 * 1000));

    await heartbeat
      .wakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "backlog_stale",
        payload: {
          issueId: issue.id,
          ageDays,
        },
        requestedByActorType: "system",
        requestedByActorId: "backlog-stale-sweep",
        contextSnapshot: {
          issueId: issue.id,
          taskId: issue.id,
          wakeReason: "backlog_stale",
          wakeBacklogAgeDays: ageDays,
          wakeSweepTaskId: issue.id,
          source: "backlog-stale-sweep",
        },
      })
      .catch((err) => logger.warn({ err, issueId: issue.id }, "backlog stale sweep wakeup failed"));

    await logActivity(db, {
      companyId: issue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: null,
      runId: null,
      action: "issue.backlog_stale_wake_emitted",
      entityType: "issue",
      entityId: issue.id,
      details: {
        agentId,
        ageDays,
        ageThresholdHours: opts.ageThresholdHours,
        auditEvent: "backlog_stale_wake_emitted",
      },
    }).catch((err) => logger.warn({ err, issueId: issue.id }, "failed to record backlog stale sweep audit event"));

    woken++;
  }

  return { scanned: candidates.length, woken };
}

// cron: "0 13 * * *" Warsaw time
// Track the last day we ran so we only sweep once per calendar day (Warsaw).
let lastSweepDateWarsawStr: string | null = null;
let sweepRunning = false;

function warsawDateString(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Warsaw" });
}

function warsawHour(): number {
  return parseInt(
    new Date().toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: "Europe/Warsaw" }),
    10,
  );
}

export async function maybeSweepBacklogStale(
  db: Db,
  heartbeat: ReturnType<typeof heartbeatService>,
): Promise<{ scanned: number; woken: number } | null> {
  const todayWarsawStr = warsawDateString();
  const hourWarsaw = warsawHour();

  // Run once per day at or after 13:00 Warsaw (concurrencyPolicy: skip_if_running)
  if (hourWarsaw < 13) return null;
  if (lastSweepDateWarsawStr === todayWarsawStr) return null;
  if (sweepRunning) return null;

  sweepRunning = true;
  lastSweepDateWarsawStr = todayWarsawStr;
  try {
    return await sweepBacklogStale(db, heartbeat);
  } finally {
    sweepRunning = false;
  }
}
