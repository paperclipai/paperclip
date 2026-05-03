import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import {
  queueIssueAssignmentWakeup,
  type IssueAssignmentWakeupDeps,
} from "./issue-assignment-wakeup.js";
import { webPushService } from "./web-push.js";

export interface WardenIssueSnapshot {
  status: string;
  dueDate: Date | string | null;
  workLeadDays: number | null;
}

/** Pure decision: given an issue snapshot and current time, should the warden
 *  promote it from backlog → todo? The start date is the UTC midnight that is
 *  workLeadDays calendar days before the due date — so a user who sets "3 days
 *  before due" on an issue due April 24 sees work begin at the start of April 21
 *  rather than at the exact second matching the due time. */
export function shouldStartWork(issue: WardenIssueSnapshot, now: Date): boolean {
  if (issue.status !== "backlog") return false;
  if (!issue.dueDate || issue.workLeadDays == null) return false;
  const lead = Math.max(0, Math.floor(issue.workLeadDays));
  const due = new Date(issue.dueDate);
  if (Number.isNaN(due.getTime())) return false;
  const dueDayStartMs = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const startAtMs = dueDayStartMs - lead * 86_400_000;
  return now.getTime() >= startAtMs;
}

export interface DeadlineWardenDeps {
  heartbeat: IssueAssignmentWakeupDeps;
}

export function deadlineWardenService(db: Db, deps: DeadlineWardenDeps) {
  const push = webPushService(db);
  return {
    tick: async (now: Date = new Date()) => {
      const candidates = await db
        .select({
          id: issues.id,
          companyId: issues.companyId,
          status: issues.status,
          dueDate: issues.dueDate,
          workLeadDays: issues.workLeadDays,
          assigneeAgentId: issues.assigneeAgentId,
          assigneeUserId: issues.assigneeUserId,
          title: issues.title,
          identifier: issues.identifier,
        })
        .from(issues)
        .where(
          and(
            eq(issues.status, "backlog"),
            isNotNull(issues.dueDate),
            isNotNull(issues.workLeadDays),
          ),
        );

      let promoted = 0;
      for (const row of candidates) {
        if (!shouldStartWork(row, now)) continue;
        const result = await db
          .update(issues)
          .set({ status: "todo", updatedAt: now })
          .where(and(eq(issues.id, row.id), eq(issues.status, "backlog")))
          .returning({ id: issues.id });
        if (result.length === 0) continue;
        promoted += 1;
        if (row.assigneeAgentId) {
          void queueIssueAssignmentWakeup({
            heartbeat: deps.heartbeat,
            issue: {
              id: row.id,
              assigneeAgentId: row.assigneeAgentId,
              status: "todo",
            },
            reason: "deadline_warden_start",
            mutation: "deadline_warden",
            contextSource: "deadline_warden",
            requestedByActorType: "system",
          });
        }
        if (row.assigneeUserId) {
          void push
            .sendToUser(row.assigneeUserId, {
              title: `Work starts now: ${row.title}`,
              body: row.identifier ? `${row.identifier} is due soon — moved to To-Do.` : "Issue moved to To-Do.",
              url: `/issues/${row.id}`,
              tag: `issue-warden-${row.id}`,
            })
            .catch((err) => logger.warn({ err, issueId: row.id }, "deadline warden push failed"));
        }
        logger.info(
          { issueId: row.id, companyId: row.companyId, workLeadDays: row.workLeadDays },
          "deadline warden promoted backlog issue",
        );
      }
      return { promoted };
    },
  };
}
