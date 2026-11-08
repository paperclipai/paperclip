import { and, eq, inArray, notInArray } from "drizzle-orm";
import { approvals, issueApprovals, issueComments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { activeIssueInteractionCondition } from "../issue-question-context.js";
import { isConversation } from "../agent-conversations.js";
import type { NativeGovernanceGate } from "./status-arbiter.js";
import { inspectPendingExecutionStage } from "../issue-execution-policy.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}


export async function lockNativeGovernanceSources(input: { db: Db; companyId: string; issueId: string }): Promise<void> {
  const interactions = await input.db.select({ kind: issueThreadInteractions.kind }).from(issueThreadInteractions)
    .where(and(eq(issueThreadInteractions.companyId, input.companyId), eq(issueThreadInteractions.issueId, input.issueId)))
    .for("share", { noWait: true });
  if (interactions.some(interaction => interaction.kind === "ask_user_questions")) {
    await input.db.select({ id: issueComments.id }).from(issueComments)
      .where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId)))
      .for("share", { noWait: true });
  }
  await input.db.select({ id: approvals.id }).from(issueApprovals)
    .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
    .where(and(eq(issueApprovals.companyId, input.companyId), eq(issueApprovals.issueId, input.issueId),
      eq(approvals.companyId, input.companyId))).for("share", { noWait: true });
}

export async function pendingNativeGovernance(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  executionState: Record<string, unknown> | null;
  ignoredInteractionIds?: string[];
}): Promise<NativeGovernanceGate | null> {
  const [issue] = await input.db.select({
    conversationAgentId: issues.conversationAgentId,
    conversationUserId: issues.conversationUserId,
    status: issues.status,
    assigneeAgentId: issues.assigneeAgentId,
    assigneeUserId: issues.assigneeUserId,
    executionPolicy: issues.executionPolicy,
    executionState: issues.executionState,
  })
    .from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  // Execution policy is issue-owned state and takes priority over the two
  // durable review surfaces. Re-read it here: the finalizer's snapshot may
  // predate an intermediate approval that advanced to a later participant.
  // Any malformed pending pair also gates completion (fail closed).
  const pendingStage = inspectPendingExecutionStage(issue ?? {
    status: "in_review",
    executionPolicy: null,
    executionState: input.executionState,
  });
  if (pendingStage.status !== "none") {
    return { kind: "execution_stage", id: input.runId };
  }
  const [pendingInteraction, pendingApproval] = await Promise.all([
    input.db
      .select({ id: issueThreadInteractions.id })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(issueThreadInteractions.companyId, input.companyId),
          eq(issueThreadInteractions.issueId, input.issueId),
          eq(issueThreadInteractions.status, "pending"),
          ...(input.ignoredInteractionIds?.length ? [notInArray(issueThreadInteractions.id, input.ignoredInteractionIds)] : []),
          activeIssueInteractionCondition({ runId: input.runId, conversationMode: isConversation(issue) }),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    input.db
      .select({ id: approvals.id })
      .from(issueApprovals)
      .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
      .where(
        and(
          eq(issueApprovals.companyId, input.companyId),
          eq(issueApprovals.issueId, input.issueId),
          eq(approvals.companyId, input.companyId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  if (pendingInteraction)
    return { kind: "interaction", id: pendingInteraction.id };
  if (pendingApproval) return { kind: "approval", id: pendingApproval.id };
  return null;
}
