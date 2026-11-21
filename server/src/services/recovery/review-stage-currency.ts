import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issueExecutionDecisions } from "@paperclipai/db";
import type { IssueExecutionState } from "@paperclipai/shared";

export type ReviewStageObsoleteReason =
  | "stage_completed"
  | "stage_approved"
  | "stage_not_in_policy"
  | "waiting_on_monitor";

export function evaluateReviewStageCurrency(input: {
  state: Pick<IssueExecutionState, "currentStageId" | "completedStageIds">;
  policyStageIds: string[] | null;
  latestDecisionOutcome: string | null;
  monitorNextCheckAt: Date | null;
  now: Date;
}): ReviewStageObsoleteReason | null {
  const stageId = input.state.currentStageId;
  if (stageId) {
    if (input.state.completedStageIds.includes(stageId)) return "stage_completed";
    if (input.latestDecisionOutcome === "approved") return "stage_approved";
    if (input.policyStageIds && !input.policyStageIds.includes(stageId)) {
      return "stage_not_in_policy";
    }
  }
  if (
    input.monitorNextCheckAt &&
    input.monitorNextCheckAt.getTime() > input.now.getTime()
  ) {
    return "waiting_on_monitor";
  }
  return null;
}

export function readPolicyStageIds(executionPolicy: unknown): string[] | null {
  if (!executionPolicy || typeof executionPolicy !== "object") return null;
  const stages = (executionPolicy as { stages?: unknown }).stages;
  if (!Array.isArray(stages)) return null;
  return stages
    .map((stage) => (stage as { id?: unknown } | null)?.id)
    .filter((id): id is string => typeof id === "string");
}

export async function readLatestStageDecisionOutcome(
  db: Db,
  input: { companyId: string; issueId: string; stageId: string | null },
): Promise<string | null> {
  if (!input.stageId) return null;
  const [row] = await db
    .select({ outcome: issueExecutionDecisions.outcome })
    .from(issueExecutionDecisions)
    .where(
      and(
        eq(issueExecutionDecisions.companyId, input.companyId),
        eq(issueExecutionDecisions.issueId, input.issueId),
        eq(issueExecutionDecisions.stageId, input.stageId),
      ),
    )
    .orderBy(desc(issueExecutionDecisions.createdAt))
    .limit(1);
  return row?.outcome ?? null;
}
