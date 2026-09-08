import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  notInArray,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  agents,
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  issueThreadInteractions,
  toolActionRequests,
  toolInvocations,
  toolActionDeliveries,
  type Db,
} from "@paperclipai/db";
import type { heartbeatService } from "./heartbeat.js";

const terminalStatuses: Array<typeof toolActionRequests.$inferSelect.status> = [
  "executed",
  "failed",
  "rejected",
  "expired",
  "cancelled",
];

/** Durable, content-free receipts. Batch ready outcomes so wake coalescing cannot lose a review. */
export function toolActionDeliveryService(
  db: Db,
  heartbeat: Pick<ReturnType<typeof heartbeatService>, "wakeup">,
) {
  async function deliver(actionRequestId: string) {
    return db.transaction(async (tx) => {
      const [source] = await tx
        .select()
        .from(toolActionDeliveries)
        .where(
          and(
            eq(toolActionDeliveries.actionRequestId, actionRequestId),
            isNull(toolActionDeliveries.deliveredAt),
          ),
        );
      if (!source) return false;
      // Separate from the issue row lock used by wakeup, which runs its own transaction.
      const [lock] = await tx.execute<{ acquired: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext(${source.companyId}), hashtext(${`tool-reviews:${source.issueId}`})) as acquired`,
      );
      if (!lock?.acquired) return false;
      const [issue] = await tx
        .select()
        .from(issues)
        .where(
          and(
            eq(issues.id, source.issueId),
            eq(issues.companyId, source.companyId),
          ),
        );
      if (!issue || ["done", "cancelled"].includes(issue.status)) {
        await tx
          .update(toolActionDeliveries)
          .set({ deliveredAt: new Date() })
          .where(
            and(
              eq(toolActionDeliveries.issueId, source.issueId),
              eq(toolActionDeliveries.companyId, source.companyId),
              isNull(toolActionDeliveries.deliveredAt),
            ),
          );
        return false;
      }
      if (!issue.assigneeAgentId) return false;
      // Outcomes belong to the originating assignee. Retire them after a
      // reassignment rather than repeatedly scanning or waking the new agent.
      await tx.update(toolActionDeliveries).set({ deliveredAt: new Date() }).where(and(
        eq(toolActionDeliveries.companyId, source.companyId),
        eq(toolActionDeliveries.issueId, issue.id),
        isNull(toolActionDeliveries.deliveredAt),
        inArray(toolActionDeliveries.actionRequestId, tx.select({ id: toolActionRequests.id }).from(toolActionRequests).where(and(
          eq(toolActionRequests.companyId, source.companyId),
          eq(toolActionRequests.issueId, issue.id),
          or(isNull(toolActionRequests.requestedByAgentId), ne(toolActionRequests.requestedByAgentId, issue.assigneeAgentId)),
          inArray(toolActionRequests.status, terminalStatuses),
        ))),
      ));
      const [agent] = await tx
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.id, issue.assigneeAgentId),
            eq(agents.companyId, source.companyId),
          ),
        );
      if (
        !agent ||
        ["paused", "terminated", "pending_approval"].includes(agent.status)
      )
        return false;
      const [pending] = await tx
        .select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions)
        .where(
          and(
            eq(issueThreadInteractions.companyId, source.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
            eq(issueThreadInteractions.status, "pending"),
          ),
        )
        .limit(1);
      if (pending) return false;
      const outcomes = await tx
        .select({
          receipt: toolActionDeliveries,
          request: toolActionRequests,
          invocation: toolInvocations,
          interaction: issueThreadInteractions,
        })
        .from(toolActionDeliveries)
        .innerJoin(
          toolActionRequests,
          and(
            eq(toolActionRequests.id, toolActionDeliveries.actionRequestId),
            eq(toolActionRequests.companyId, source.companyId),
            eq(toolActionRequests.issueId, issue.id),
            eq(toolActionRequests.requestedByAgentId, agent.id),
          ),
        )
        .innerJoin(
          toolInvocations,
          and(
            eq(toolInvocations.id, toolActionRequests.invocationId),
            eq(toolInvocations.companyId, source.companyId),
            eq(toolInvocations.issueId, issue.id),
            eq(toolInvocations.agentId, agent.id),
          ),
        )
        .innerJoin(
          issueThreadInteractions,
          and(
            eq(issueThreadInteractions.id, toolActionDeliveries.interactionId),
            eq(issueThreadInteractions.id, toolActionRequests.interactionId),
            eq(issueThreadInteractions.companyId, source.companyId),
            eq(issueThreadInteractions.issueId, issue.id),
          ),
        )
        .where(
          and(
            eq(toolActionDeliveries.companyId, source.companyId),
            eq(toolActionDeliveries.issueId, issue.id),
            isNull(toolActionDeliveries.deliveredAt),
            inArray(toolActionRequests.status, terminalStatuses),
          ),
        )
        .orderBy(
          asc(toolActionDeliveries.createdAt),
          asc(toolActionDeliveries.actionRequestId),
        );
      if (!outcomes.length) return false;
      const sourceRunIds = outcomes.flatMap((row) =>
        row.invocation.runId ? [row.invocation.runId] : [],
      );
      if (sourceRunIds.length) {
        const [running] = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(
            and(
              eq(heartbeatRuns.companyId, source.companyId),
              inArray(heartbeatRuns.id, sourceRunIds),
              inArray(heartbeatRuns.status, ["queued", "running"]),
            ),
          )
          .limit(1);
        if (running) return false;
      }
      const first = outcomes[0];
      const idempotencyKey = `tool-action-response:${first.request.id}`;
      const existing = async () =>
        (
          await db
            .select({
              id: agentWakeupRequests.id,
              payload: agentWakeupRequests.payload,
            })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, source.companyId),
                eq(agentWakeupRequests.idempotencyKey, idempotencyKey),
                notInArray(agentWakeupRequests.status, [
                  "skipped",
                  "failed",
                  "cancelled",
                ]),
              ),
            )
            .limit(1)
        )[0];
      if (!(await existing())) {
        const toolActions = outcomes.map(
          ({ request, invocation, interaction }) => {
            const result = interaction.result as {
              reason?: string;
              toolAction?: { resultSummary?: string; errorMessage?: string };
            } | null;
            const instructions =
              request.status === "executed"
                ? "The approved action already ran. Do not call it again; continue with the recorded result."
                : request.status === "rejected"
                  ? "The human declined this action. Do not retry the same call. Adjust your approach or explain what is blocked."
                  : request.status === "expired" ||
                      request.status === "cancelled"
                    ? "The review is no longer available. Do not execute the stored request. Explain the recorded outcome before requesting another review."
                    : "The approved action did not complete successfully. Do not automatically replay it; inspect the recorded outcome first.";
            return {
              toolName: invocation.toolName,
              actionRequestId: request.id,
              invocationId: invocation.id,
              decision:
                request.status === "rejected"
                  ? "rejected"
                  : request.decidedByUserId
                    ? "accepted"
                    : "none",
              executionStatus: request.status,
              resultSummary:
                result?.toolAction?.resultSummary ??
                invocation.resultSummary?.summary ??
                "",
              error:
                result?.toolAction?.errorMessage ?? invocation.errorMessage,
              declineReason: result?.reason,
              instructions,
            };
          },
        );
        const context = {
          issueId: issue.id,
          taskId: issue.id,
          interactionId: first.interaction.id,
          interactionIds: outcomes.map((row) => row.interaction.id),
          interactionKind: first.interaction.kind,
          interactionStatus: first.interaction.status,
          sourceRunId: first.invocation.runId,
          toolAction: toolActions[0],
          toolActions,
          toolActionRequestIds: outcomes.map((row) => row.request.id),
          paperclipAgentMessage: {
            text: toolActions
              .map(
                (action) =>
                  `${action.toolName}: ${action.instructions}\n${action.resultSummary}\n${action.error ?? ""}\n${action.declineReason ?? ""}`,
              )
              .join("\n\n"),
            source: "tool_action_review",
            sessionId: first.interaction.id,
          },
        };
        await heartbeat.wakeup(agent.id, {
          source: "automation",
          triggerDetail: "system",
          reason: "issue_commented",
          idempotencyKey,
          issueStateGuard: {
            statuses: [issue.status],
            assigneeAgentId: agent.id,
          },
          requestedByActorType: "user",
          requestedByActorId: first.request.decidedByUserId ?? "board",
          payload: { ...context, mutation: "interaction" },
          contextSnapshot: {
            ...context,
            wakeReason: "issue_commented",
            source: "tool_action_review",
          },
        });
      }
      const committedWake = await existing();
      if (!committedWake) return false;
      const committedIds = Array.isArray(
        committedWake.payload?.toolActionRequestIds,
      )
        ? committedWake.payload.toolActionRequestIds
        : [first.request.id];
      await tx
        .update(toolActionDeliveries)
        .set({ deliveredAt: new Date() })
        .where(
          inArray(
            toolActionDeliveries.actionRequestId,
            outcomes
              .map((row) => row.request.id)
              .filter((id) => committedIds.includes(id)),
          ),
        );
      return true;
    });
  }
  return {
    deliver,
    async sweepPending() {
      let cursor: string | undefined;
      let scanned = 0;
      let delivered = 0;
      for (;;) {
        const pending = await db
          .select({ id: toolActionDeliveries.actionRequestId })
          .from(toolActionDeliveries)
          .innerJoin(
            toolActionRequests,
            eq(toolActionRequests.id, toolActionDeliveries.actionRequestId),
          )
          .where(
            and(
              isNull(toolActionDeliveries.deliveredAt),
              inArray(toolActionRequests.status, terminalStatuses),
              cursor
                ? gt(toolActionDeliveries.actionRequestId, cursor)
                : undefined,
            ),
          )
          .orderBy(asc(toolActionDeliveries.actionRequestId))
          .limit(100);
        for (const row of pending) if (await deliver(row.id)) delivered++;
        scanned += pending.length;
        if (pending.length < 100) break;
        cursor = pending[pending.length - 1].id;
      }
      return { scanned, delivered };
    },
  };
}
