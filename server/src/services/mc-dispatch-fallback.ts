import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueRuns, issues } from "@paperclipai/db";
import type { McDispatchFallbackOutcome } from "@paperclipai/shared";
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
            "Wave-1 stub: no MC-spawn invoked; activity-event-write deferred to 4c-2.",
          ],
        };
      }

      warnings.push("MC-spawn integration not yet wired — falling back to hold_and_alert (4c-2 pending)");
      return {
        outcome: "rejected-hold-and-alert" satisfies McDispatchFallbackOutcome,
        legacyTaskId: null,
        issueRunId: input.issueRunId,
        warnings,
      };
    },
  };
}
