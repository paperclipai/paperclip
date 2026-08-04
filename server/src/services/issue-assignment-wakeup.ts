import { agentWakeupRequests, agents, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

type WakeupTriggerDetail = "manual" | "ping" | "callback" | "system";
type WakeupSource = "timer" | "assignment" | "on_demand" | "automation";

export interface IssueAssignmentWakeupDeps {
  wakeup: (
    agentId: string,
    opts: {
      source?: WakeupSource;
      triggerDetail?: WakeupTriggerDetail;
      reason?: string | null;
      payload?: Record<string, unknown> | null;
      requestedByActorType?: "user" | "agent" | "system";
      requestedByActorId?: string | null;
      contextSnapshot?: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}

export function queueIssueAssignmentWakeup(input: {
  db: Db;
  heartbeat: IssueAssignmentWakeupDeps;
  issue: { id: string; assigneeAgentId: string | null; status: string };
  reason: string;
  mutation: string;
  contextSource: string;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  rethrowOnError?: boolean;
}) {
  if (!input.issue.assigneeAgentId || input.issue.status === "backlog") return;

  return input.heartbeat
    .wakeup(input.issue.assigneeAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: input.reason,
      payload: { issueId: input.issue.id, mutation: input.mutation },
      requestedByActorType: input.requestedByActorType,
      requestedByActorId: input.requestedByActorId ?? null,
      contextSnapshot: { issueId: input.issue.id, source: input.contextSource },
    })
    .catch(async (err) => {
      const agent = await input.db
        .select({ companyId: agents.companyId })
        .from(agents)
        .where(eq(agents.id, input.issue.assigneeAgentId!))
        .then((rows) => rows[0] ?? null);
      if (agent) {
        await input.db.insert(agentWakeupRequests).values({
          companyId: agent.companyId,
          agentId: input.issue.assigneeAgentId!,
          source: "assignment",
          triggerDetail: "system",
          reason: "issue_assignment_wakeup_failed",
          payload: { issueId: input.issue.id, mutation: input.mutation },
          status: "failed",
          requestedByActorType: input.requestedByActorType ?? null,
          requestedByActorId: input.requestedByActorId ?? null,
          finishedAt: new Date(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.warn({ err, issueId: input.issue.id }, "failed to wake assignee on issue assignment");
      if (input.rethrowOnError) throw err;
      return null;
    });
}
