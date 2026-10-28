import { and, eq, inArray, notInArray } from "drizzle-orm";
import { approvals, issueApprovals, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { activeIssueInteractionCondition } from "../issue-question-context.js";
import { isConversation } from "../agent-conversations.js";
import type { NativeGovernanceGate } from "./status-arbiter.js";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}

export async function pendingNativeGovernance(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  executionState: Record<string, unknown> | null;
  ignoredInteractionIds?: string[];
}): Promise<NativeGovernanceGate | null> {
  // Execution policy is issue-owned state and takes priority over the two
  // durable review surfaces. Completion must mediate all three authorities.
  if (record(input.executionState).status === "pending") {
    return { kind: "execution_stage", id: input.runId };
  }
  const [issue] = await input.db.select({ conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId })
    .from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
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

