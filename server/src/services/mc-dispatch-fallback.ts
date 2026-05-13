import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, issueRuns, issues } from "@paperclipai/db";
import {
  ISSUE_RUNS_LOCK_TTL_SECONDS,
  type McDispatchFallbackOutcome,
} from "@paperclipai/shared";
import { notFound } from "../errors.js";

/**
 * mc-dispatch-fallback service — Jarvis-OS Phase-4 4c.
 *
 * Wave 1 (4c-3 dry-run stub):
 *   - evaluate(issueId, executorRequested): determines eligibility
 *   - record(input): persists an audit-event but does NOT spawn an MC process
 *
 * Full spawn-integration with mission-control/src/lib/dispatcher.ts comes in
 * 4c-2 + 4c-5 after Marco-Decision (see plans/phase-4-code-plan-2026-05-11.md
 * § 4c-2 "Kein Enum hermes-fallback-mc ohne Marco-Decision").
 *
 * Per 4D-5 (Fallback-Encoding=A): no schema-churn, the fallback is encoded as
 * executor='mc-dispatch' + metadata fallback_from='hermes' on the issue_runs
 * row. This service writes the eligibility decision but defers the actual
 * row-creation to either the dry-run path (record-only) or the future spawn
 * integration.
 */
export interface McDispatchFallbackService {
  evaluate(input: EvaluateInput): Promise<EvaluateResult>;
  recordDecision(input: RecordInput): Promise<RecordResult>;
  listEligibleIssues(input: ListEligibleInput): Promise<EligibleIssue[]>;
}

export interface ListEligibleInput {
  companyId: string;
  limit?: number;
}

export interface EligibleIssue {
  issueId: string;
  assigneeAgentId: string;
  issueStatus: string;
}

export interface EvaluateInput {
  companyId: string;
  issueId: string;
}

export type EvaluateResult =
  | { eligible: true }
  | { eligible: false; reason: NonEligibleReason };

export type NonEligibleReason =
  | "issue-not-found"
  | "lock-active"
  | "issue-blocked";

export interface RecordInput {
  companyId: string;
  issueId: string;
  issueRunId: string | null;
  fallbackFrom: "hermes";
  reason: string;
  hermesHealthSnapshot?: Record<string, unknown>;
  dryRun: boolean;
}

export interface RecordResult {
  outcome: McDispatchFallbackOutcome;
  legacyTaskId: string | null;
  issueRunId: string | null;
  warnings: string[];
}

const BLOCKED_ISSUE_STATUSES = new Set(["closed", "cancelled", "blocked", "waiting_approval"]);

export function mcDispatchFallbackService(db: Db): McDispatchFallbackService {
  async function fetchIssue(issueId: string) {
    const rows = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function fetchActiveLock(issueId: string) {
    const rows = await db
      .select({ runId: issueRuns.runId })
      .from(issueRuns)
      .where(and(eq(issueRuns.issueId, issueId), eq(issueRuns.status, "running")))
      .limit(1);
    return rows[0] ?? null;
  }

  return {
    async evaluate(input) {
      const issue = await fetchIssue(input.issueId);
      if (!issue) {
        return { eligible: false, reason: "issue-not-found" };
      }
      if (issue.companyId !== input.companyId) {
        return { eligible: false, reason: "issue-not-found" };
      }
      if (BLOCKED_ISSUE_STATUSES.has(issue.status)) {
        return { eligible: false, reason: "issue-blocked" };
      }
      const lock = await fetchActiveLock(input.issueId);
      if (lock) {
        return { eligible: false, reason: "lock-active" };
      }
      return { eligible: true };
    },

    async recordDecision(input) {
      const issue = await fetchIssue(input.issueId);
      if (!issue) {
        throw notFound("issue not found");
      }

      const warnings: string[] = [];
      const lock = await fetchActiveLock(input.issueId);
      if (lock) {
        return {
          outcome: "rejected-lock-active" satisfies McDispatchFallbackOutcome,
          legacyTaskId: null,
          issueRunId: lock.runId,
          warnings,
        };
      }

      if (BLOCKED_ISSUE_STATUSES.has(issue.status)) {
        return {
          outcome: "rejected-issue-blocked" satisfies McDispatchFallbackOutcome,
          legacyTaskId: null,
          issueRunId: null,
          warnings: [`issue.status=${issue.status} blocks fallback`],
        };
      }

      if (input.dryRun) {
        return {
          outcome: "accepted-dry-run" satisfies McDispatchFallbackOutcome,
          legacyTaskId: null,
          issueRunId: input.issueRunId,
          warnings: [
            "dry-run: no issue_runs row written; activity-event-write deferred to MC-spawn integration.",
          ],
        };
      }

      const ownerToken = `mc-dispatch-fallback@${input.fallbackFrom}`;
      const summaryMarker = `[fallback_from=${input.fallbackFrom} reason=${input.reason}]`;
      const inserted = await db
        .insert(issueRuns)
        .values({
          companyId: input.companyId,
          issueId: input.issueId,
          executor: "mc-dispatch",
          leaseOwner: ownerToken,
          leaseExpiresAt: sql`now() + (${ISSUE_RUNS_LOCK_TTL_SECONDS} || ' seconds')::interval`,
          status: "running",
          promptSnapshotPath: null,
          resultSummary: summaryMarker,
        })
        .onConflictDoNothing({
          target: issueRuns.issueId,
          where: sql`${issueRuns.status} = 'running'`,
        })
        .returning({ runId: issueRuns.runId });

      if (!inserted[0]) {
        const existing = await fetchActiveLock(input.issueId);
        return {
          outcome: "rejected-lock-active" satisfies McDispatchFallbackOutcome,
          legacyTaskId: null,
          issueRunId: existing?.runId ?? null,
          warnings: ["race: another lock acquired between evaluation and spawn"],
        };
      }

      return {
        outcome: "accepted-spawned" satisfies McDispatchFallbackOutcome,
        legacyTaskId: null,
        issueRunId: inserted[0].runId,
        warnings,
      };
    },

    async listEligibleIssues(input) {
      const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
      const blockedStatuses = Array.from(BLOCKED_ISSUE_STATUSES);

      const activeRuns = await db
        .select({ issueId: issueRuns.issueId })
        .from(issueRuns)
        .where(and(eq(issueRuns.companyId, input.companyId), eq(issueRuns.status, "running")));
      const lockedIssueIds = activeRuns.map((row) => row.issueId);

      const conditions = [
        eq(issues.companyId, input.companyId),
        notInArray(issues.status, blockedStatuses),
        eq(agents.executor, "hermes"),
      ];
      if (lockedIssueIds.length > 0) {
        conditions.push(notInArray(issues.id, lockedIssueIds));
      }

      const rows = await db
        .select({
          issueId: issues.id,
          assigneeAgentId: issues.assigneeAgentId,
          issueStatus: issues.status,
        })
        .from(issues)
        .innerJoin(agents, eq(issues.assigneeAgentId, agents.id))
        .where(and(...conditions))
        .limit(limit);

      return rows
        .filter((r): r is { issueId: string; assigneeAgentId: string; issueStatus: string } =>
          r.assigneeAgentId !== null,
        );
    },
  };
}
