import { and, eq, inArray, notInArray } from "drizzle-orm";
import { approvals, issueApprovals, issueComments, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { activeIssueInteractionCondition } from "../issue-question-context.js";
import { isConversation } from "../agent-conversations.js";
import type { NativeGovernanceGate } from "./status-arbiter.js";

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

/** The pending thread interaction (question or confirmation card) that gates this run, if any. */
async function pendingNativeInteraction(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  ignoredInteractionIds?: string[];
  /** Only a card this run created; any other card can hold the task but not present the turn. */
  createdByRun?: boolean;
}): Promise<{ id: string } | null> {
  const [issue] = await input.db.select({ conversationAgentId: issues.conversationAgentId, conversationUserId: issues.conversationUserId })
    .from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  return input.db
    .select({ id: issueThreadInteractions.id })
    .from(issueThreadInteractions)
    .where(
      and(
        eq(issueThreadInteractions.companyId, input.companyId),
        eq(issueThreadInteractions.issueId, input.issueId),
        eq(issueThreadInteractions.status, "pending"),
        ...(input.ignoredInteractionIds?.length ? [notInArray(issueThreadInteractions.id, input.ignoredInteractionIds)] : []),
        ...(input.createdByRun ? [eq(issueThreadInteractions.sourceRunId, input.runId)] : []),
        activeIssueInteractionCondition({ runId: input.runId, conversationMode: isConversation(issue) }),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
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
  const [pendingInteraction, pendingApproval] = await Promise.all([
    pendingNativeInteraction(input),
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


/**
 * A committed conversation turn has answered the person, whatever status its
 * task keeps. An approval, an execution stage or a card the run did not create
 * (an earlier turn's, or one the board addressed to someone else) can hold the
 * task, but none presents that answer in the conversation. Only a pending
 * question or confirmation card this run created is the turn's visible response.
 */
export async function conversationTurnAnswered(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
}): Promise<boolean> {
  // Check cards on their own: an execution stage outranks a card as the
  // status gate, but it does not present the turn.
  return !(await pendingNativeInteraction({ ...input, createdByRun: true }));
}

/**
 * The one rule for whether a successful conversation turn's prose is its
 * answer. Live run completion and background presentation recovery both use
 * it, so a restart between the status commit and the live presentation
 * presents the same reply the live path would have.
 */
export async function conversationTurnPresentsAnswer(input: {
  db: Db;
  companyId: string;
  issueId: string;
  runId: string;
  finalizationPhase: unknown;
  finalizationReasonCode: unknown;
}): Promise<boolean> {
  if (input.finalizationReasonCode === "conversation_turn_finished") return true;
  // A turn left waiting on an approval, an execution stage or a blocker still
  // answered the person. Only its own question card presents it instead.
  return input.finalizationPhase === "committed" && await conversationTurnAnswered(input);
}
