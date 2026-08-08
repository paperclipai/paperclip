/**
 * Gate 1: working-transition and deadline-before-mutation gates (8b616780)
 *
 * Fail-closed hardening gates for Paperclip 722:
 * - working-transition: Only allow status transitions from valid working states.
 *   Prevents silent state corruption (e.g., done→todo without explicit re-open).
 * - deadline-before-mutation: If an issue has a dueDate in the past, block
 *   non-status mutations unless the caller explicitly acknowledges the overdue state.
 *
 * Parent: bd78b074 (Paperclip 722 harden)
 * Program: JAC-3662
 */

import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { forbidden } from "../errors.js";

// ---------------------------------------------------------------------------
// Valid status transition map (fail-closed: any transition NOT in this map is denied)
// ---------------------------------------------------------------------------

const VALID_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  backlog: new Set(["todo", "cancelled"]),
  todo: new Set(["in_progress", "blocked", "cancelled"]),
  in_progress: new Set(["in_review", "blocked", "done", "cancelled"]),
  in_review: new Set(["in_progress", "done", "blocked", "cancelled"]),
  blocked: new Set(["todo", "in_progress", "cancelled"]),
  done: new Set(["in_progress"]), // re-open only to in_progress
  cancelled: new Set(["todo"]), // un-cancel only to todo
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TransitionGateInput {
  companyId: string;
  issueId: string;
  currentStatus: string;
  targetStatus: string;
  actorRunId?: string | null;
}

export interface DeadlineGateInput {
  companyId: string;
  issueId: string;
  dueDate: string | null | undefined;
  mutationKind: string; // e.g. "title", "description", "assignee"
  overrideDeadline?: boolean;
}

export function isValidStatusTransition(current: string, target: string): boolean {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed) {
    // Unknown current status → fail closed
    return false;
  }
  return allowed.has(target);
}

export function issueTransitionGateService(_db: Db) {
  return {
    /**
     * Assert that a status transition is valid. Throws forbidden on invalid
     * transitions (fail-closed).
     */
    assertValidTransition(input: TransitionGateInput): void {
      if (!isValidStatusTransition(input.currentStatus, input.targetStatus)) {
        throw forbidden(
          `Invalid status transition: "${input.currentStatus}" → "${input.targetStatus}" is not allowed. ` +
            `Allowed targets from "${input.currentStatus}": ${
              [...(VALID_TRANSITIONS[input.currentStatus] ?? [])].join(", ") || "none"
            }`,
          {
            code: "invalid_status_transition",
            currentStatus: input.currentStatus,
            targetStatus: input.targetStatus,
            issueId: input.issueId,
          },
        );
      }
    },

    /**
     * Assert that a mutation on an overdue issue is either a status change or
     * explicitly acknowledges the overdue state. Fail-closed: blocks all other
     * mutations on overdue issues.
     */
    assertDeadlineBeforeMutation(input: DeadlineGateInput): void {
      if (!input.dueDate) return; // no deadline → pass

      const dueDate = new Date(input.dueDate);
      if (isNaN(dueDate.getTime())) return; // unparseable → pass (don't block on bad data)

      const now = new Date();
      if (dueDate >= now) return; // not overdue → pass

      // Overdue: only status changes or explicit override are allowed
      const isStatusMutation = input.mutationKind === "status";
      if (isStatusMutation || input.overrideDeadline) return;

      throw forbidden(
        `Cannot mutate "${input.mutationKind}" on overdue issue ${input.issueId}. ` +
          `Due date was ${input.dueDate}. Use overrideDeadline=true to proceed.`,
        {
          code: "overdue_issue_mutation_blocked",
          issueId: input.issueId,
          dueDate: input.dueDate,
          mutationKind: input.mutationKind,
        },
      );
    },
  };
}

/**
 * Resolve the current status of an issue from the database.
 * Returns null if the issue is not found (caller should handle).
 */
export async function resolveIssueStatus(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);

  if (!row) return null;

  // Also verify company scope
  const [scoped] = await db
    .select({ status: issues.status })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1);

  return scoped?.status ?? null;
}
