import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  agents,
  companies,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

const LIVE_HEARTBEAT_RUN_STATUSES = ["queued", "running"] as const;
const TERMINAL_HEARTBEAT_RUN_STATUSES = ["succeeded", "failed", "cancelled", "timed_out"] as const;
const REPAIRABLE_WAKEUP_STATUSES = ["queued", "claimed", "deferred_issue_execution"] as const;
const BLOCKED_COMPANY_STATUSES = ["paused", "archived"] as const;

type RuntimeIntegritySummary = {
  wakeupsReconciled: number;
  runsCancelled: number;
  issuesNormalized: number;
  issuesRebound: number;
};

type RuntimeIntegrityInspection = {
  staleWakeups: {
    count: number;
    wakeupIds: string[];
  };
  blockedQueuedRuns: {
    count: number;
    runIds: string[];
  };
  brokenInProgressIssues: {
    count: number;
    rebindableIssueIds: string[];
    normalizableIssueIds: string[];
    ambiguousIssueIds: string[];
  };
};

type LiveRunCandidate = {
  id: string;
  agentId: string;
  agentName: string | null;
  status: string;
  startedAt: Date | null;
  createdAt: Date;
};

type StaleWakeup = {
  wakeupId: string;
  runStatus: string;
  runError: string | null;
  runFinishedAt: Date | null;
};

type BlockedQueuedRun = {
  id: string;
  wakeupRequestId: string | null;
  companyStatus: string;
};

type BrokenIssueClassification = {
  rebindable: Array<{
    issueId: string;
    issueStartedAt: Date | null;
    candidate: LiveRunCandidate;
  }>;
  normalizable: string[];
  ambiguous: Array<{
    issueId: string;
    candidateRunIds: string[];
  }>;
};

function normalizeAgentNameKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function toWakeupTerminalStatus(runStatus: string): "completed" | "failed" | "cancelled" {
  if (runStatus === "succeeded") return "completed";
  if (runStatus === "cancelled") return "cancelled";
  return "failed";
}

function toRunCandidate(
  row:
    | {
        id: string;
        agentId: string;
        status: string;
        startedAt: Date | null;
        createdAt: Date;
        agentName: string | null;
      }
    | null
    | undefined,
): LiveRunCandidate | null {
  if (!row) return null;
  if (!LIVE_HEARTBEAT_RUN_STATUSES.includes(row.status as (typeof LIVE_HEARTBEAT_RUN_STATUSES)[number])) {
    return null;
  }
  return {
    id: row.id,
    agentId: row.agentId,
    agentName: row.agentName,
    status: row.status,
    startedAt: row.startedAt,
    createdAt: row.createdAt,
  };
}

export function runtimeIntegrityService(db: Db) {
  async function listStaleWakeups(): Promise<StaleWakeup[]> {
    return db
      .select({
        wakeupId: agentWakeupRequests.id,
        runStatus: heartbeatRuns.status,
        runError: heartbeatRuns.error,
        runFinishedAt: heartbeatRuns.finishedAt,
      })
      .from(agentWakeupRequests)
      .innerJoin(heartbeatRuns, eq(agentWakeupRequests.runId, heartbeatRuns.id))
      .where(
        and(
          inArray(agentWakeupRequests.status, [...REPAIRABLE_WAKEUP_STATUSES]),
          inArray(heartbeatRuns.status, [...TERMINAL_HEARTBEAT_RUN_STATUSES]),
        ),
      );
  }

  async function listBlockedQueuedRuns(): Promise<BlockedQueuedRun[]> {
    return db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
        companyStatus: companies.status,
      })
      .from(heartbeatRuns)
      .innerJoin(companies, eq(heartbeatRuns.companyId, companies.id))
      .where(
        and(
          eq(heartbeatRuns.status, "queued"),
          inArray(companies.status, [...BLOCKED_COMPANY_STATUSES]),
        ),
      );
  }

  async function getLiveRunCandidateById(runId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
        agentName: agents.name,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.id, runId),
          inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
        ),
      )
      .then((rows) => toRunCandidate(rows[0] ?? null));
  }

  async function listLiveRunCandidatesForIssue(issueId: string, companyId: string) {
    return db
      .select({
        id: heartbeatRuns.id,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        createdAt: heartbeatRuns.createdAt,
        agentName: agents.name,
      })
      .from(heartbeatRuns)
      .innerJoin(agents, eq(heartbeatRuns.agentId, agents.id))
      .where(
        and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...LIVE_HEARTBEAT_RUN_STATUSES]),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
        ),
      )
      .orderBy(
        sql`case when ${heartbeatRuns.status} = 'running' then 0 else 1 end`,
        asc(heartbeatRuns.createdAt),
      )
      .then((rows) => rows.map((row) => toRunCandidate(row)).filter((row): row is LiveRunCandidate => Boolean(row)));
  }

  async function classifyBrokenInProgressIssues(): Promise<BrokenIssueClassification> {
    const openIssues = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
        startedAt: issues.startedAt,
      })
      .from(issues)
      .where(eq(issues.status, "in_progress"));

    const rebindable: BrokenIssueClassification["rebindable"] = [];
    const normalizable: string[] = [];
    const ambiguous: BrokenIssueClassification["ambiguous"] = [];

    for (const issue of openIssues) {
      const candidateById = new Map<string, LiveRunCandidate>();

      if (issue.checkoutRunId) {
        const candidate = await getLiveRunCandidateById(issue.checkoutRunId);
        if (candidate) candidateById.set(candidate.id, candidate);
      }

      if (issue.executionRunId) {
        const candidate = await getLiveRunCandidateById(issue.executionRunId);
        if (candidate) candidateById.set(candidate.id, candidate);
      }

      for (const candidate of await listLiveRunCandidatesForIssue(issue.id, issue.companyId)) {
        candidateById.set(candidate.id, candidate);
      }

      const candidates = [...candidateById.values()];
      const hasBoundLiveRun =
        issue.assigneeAgentId &&
        issue.checkoutRunId &&
        issue.executionRunId &&
        issue.checkoutRunId === issue.executionRunId &&
        candidates.length === 1 &&
        candidates[0]?.id === issue.executionRunId &&
        candidates[0].agentId === issue.assigneeAgentId;

      if (hasBoundLiveRun) continue;

      if (candidates.length === 1) {
        rebindable.push({
          issueId: issue.id,
          issueStartedAt: issue.startedAt,
          candidate: candidates[0],
        });
        continue;
      }

      if (candidates.length > 1) {
        ambiguous.push({
          issueId: issue.id,
          candidateRunIds: candidates.map((candidate) => candidate.id),
        });
        continue;
      }

      normalizable.push(issue.id);
    }

    return { rebindable, normalizable, ambiguous };
  }

  async function reconcileWakeupStatuses(now: Date) {
    const staleWakeups = await listStaleWakeups();
    let reconciled = 0;

    for (const wakeup of staleWakeups) {
      const status = toWakeupTerminalStatus(wakeup.runStatus);
      const error = status === "completed" ? null : wakeup.runError ?? `Linked run ended as ${wakeup.runStatus}`;
      const updated = await db
        .update(agentWakeupRequests)
        .set({
          status,
          finishedAt: wakeup.runFinishedAt ?? now,
          error,
          updatedAt: now,
        })
        .where(
          and(
            eq(agentWakeupRequests.id, wakeup.wakeupId),
            inArray(agentWakeupRequests.status, [...REPAIRABLE_WAKEUP_STATUSES]),
          ),
        )
        .returning({ id: agentWakeupRequests.id })
        .then((rows) => rows[0] ?? null);

      if (updated) reconciled += 1;
    }

    return reconciled;
  }

  async function cancelBlockedQueuedRuns(now: Date) {
    const blockedQueuedRuns = await listBlockedQueuedRuns();
    let cancelled = 0;

    for (const run of blockedQueuedRuns) {
      const reason =
        run.companyStatus === "archived"
          ? "Cancelled because the company is archived"
          : "Cancelled because the company is paused";

      const updated = await db.transaction(async (tx) => {
        const cancelledRun = await tx
          .update(heartbeatRuns)
          .set({
            status: "cancelled",
            finishedAt: now,
            error: reason,
            errorCode: "cancelled",
            updatedAt: now,
          })
          .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.status, "queued")))
          .returning({
            id: heartbeatRuns.id,
            wakeupRequestId: heartbeatRuns.wakeupRequestId,
          })
          .then((rows) => rows[0] ?? null);

        if (!cancelledRun) return false;

        if (cancelledRun.wakeupRequestId) {
          await tx
            .update(agentWakeupRequests)
            .set({
              status: "cancelled",
              finishedAt: now,
              error: reason,
              updatedAt: now,
            })
            .where(eq(agentWakeupRequests.id, cancelledRun.wakeupRequestId));
        }

        await tx
          .update(issues)
          .set({
            executionRunId: null,
            executionAgentNameKey: null,
            executionLockedAt: null,
            updatedAt: now,
          })
          .where(eq(issues.executionRunId, cancelledRun.id));

        await tx
          .update(issues)
          .set({
            checkoutRunId: null,
            updatedAt: now,
          })
          .where(eq(issues.checkoutRunId, cancelledRun.id));

        return true;
      });

      if (updated) cancelled += 1;
    }

    return cancelled;
  }

  async function repairInProgressIssues(now: Date) {
    const inspection = await classifyBrokenInProgressIssues();
    let issuesNormalized = 0;
    let issuesRebound = 0;

    for (const issue of inspection.rebindable) {
      const rebound = await db
        .update(issues)
        .set({
          status: "in_progress",
          assigneeAgentId: issue.candidate.agentId,
          assigneeUserId: null,
          checkoutRunId: issue.candidate.id,
          executionRunId: issue.candidate.id,
          executionAgentNameKey: normalizeAgentNameKey(issue.candidate.agentName),
          executionLockedAt: now,
          startedAt: issue.issueStartedAt ?? issue.candidate.startedAt ?? issue.candidate.createdAt ?? now,
          completedAt: null,
          cancelledAt: null,
          updatedAt: now,
        })
        .where(and(eq(issues.id, issue.issueId), eq(issues.status, "in_progress")))
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      if (rebound) issuesRebound += 1;
    }

    for (const issueId of inspection.normalizable) {
      const normalized = await db
        .update(issues)
        .set({
          status: "todo",
          assigneeAgentId: null,
          assigneeUserId: null,
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          updatedAt: now,
        })
        .where(and(eq(issues.id, issueId), eq(issues.status, "in_progress")))
        .returning({ id: issues.id })
        .then((rows) => rows[0] ?? null);

      if (normalized) issuesNormalized += 1;
    }

    for (const issue of inspection.ambiguous) {
      logger.warn(
        {
          issueId: issue.issueId,
          candidateRunIds: issue.candidateRunIds,
        },
        "runtime integrity skipped ambiguous in-progress issue repair",
      );
    }

    return { issuesNormalized, issuesRebound };
  }

  return {
    async inspect(): Promise<RuntimeIntegrityInspection> {
      const [staleWakeups, blockedQueuedRuns, brokenIssues] = await Promise.all([
        listStaleWakeups(),
        listBlockedQueuedRuns(),
        classifyBrokenInProgressIssues(),
      ]);

      return {
        staleWakeups: {
          count: staleWakeups.length,
          wakeupIds: staleWakeups.map((wakeup) => wakeup.wakeupId),
        },
        blockedQueuedRuns: {
          count: blockedQueuedRuns.length,
          runIds: blockedQueuedRuns.map((run) => run.id),
        },
        brokenInProgressIssues: {
          count:
            brokenIssues.rebindable.length +
            brokenIssues.normalizable.length +
            brokenIssues.ambiguous.length,
          rebindableIssueIds: brokenIssues.rebindable.map((issue) => issue.issueId),
          normalizableIssueIds: brokenIssues.normalizable,
          ambiguousIssueIds: brokenIssues.ambiguous.map((issue) => issue.issueId),
        },
      };
    },

    async reconcileAll(now = new Date()): Promise<RuntimeIntegritySummary> {
      const runsCancelled = await cancelBlockedQueuedRuns(now);
      const wakeupsReconciled = await reconcileWakeupStatuses(now);
      const { issuesNormalized, issuesRebound } = await repairInProgressIssues(now);

      if (runsCancelled > 0 || wakeupsReconciled > 0 || issuesNormalized > 0 || issuesRebound > 0) {
        logger.warn(
          {
            runsCancelled,
            wakeupsReconciled,
            issuesNormalized,
            issuesRebound,
          },
          "runtime integrity reconciliation repaired control-plane state",
        );
      }

      return {
        wakeupsReconciled,
        runsCancelled,
        issuesNormalized,
        issuesRebound,
      };
    },
  };
}
