import { agents, chatConversations, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { HttpError } from "../../errors.js";
import { isConversation } from "../../lib/conversation-wake-policy.js";
import { resolveExternalRunAuthorizingUser } from "../../modules/external-agents/index.js";
import { assertAssignableAgent } from "../agent-assignability.js";
import { agentInteractionDenial } from "../agent-interaction-policy.js";
import { evaluateAgentInvokabilityFromDb } from "../agent-invokability.js";
import { authorizationService, type AuthorizationActor } from "../authorization.js";
import { nativeRunKeyScope } from "./native-skill-test-scope.js";

export type BlockerHandoffEligibility =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "not_task_owner"
        | "conversation_or_chat_locked"
        | "unavailable"
        | "unassignable"
        | "unauthorized"
        | "interaction_denied";
      message: string;
    };

/** Tasks bound to an external chat channel lock their agent assignment (`chat_binding_agent_locked`). */
export async function hasExternalChatBinding(
  db: Db,
  companyId: string,
  issueId: string,
): Promise<boolean> {
  const [binding] = await db
    .select({ id: chatConversations.id })
    .from(chatConversations)
    .where(and(eq(chatConversations.companyId, companyId), eq(chatConversations.issueId, issueId)))
    .limit(1);
  return Boolean(binding);
}

/**
 * Single authority check for handing a blocked task to another named agent.
 * Shared across report-time feedback, finalizer arbitration, and the committer's
 * under-lock recheck so all three layers enforce the exact same invariants,
 * including `tasks:assign` authorization with the run's full principal (`keyScope`
 * and external `authorizingUserId`), assignment policy, and interaction policy.
 */
export async function evaluateBlockerAgentHandoff(
  db: Db,
  input: {
    companyId: string;
    issue: {
      id: string;
      projectId: string | null;
      parentId: string | null;
      status: string;
      workMode: string;
      conversationAgentId: string | null;
      conversationUserId: string | null;
      assigneeAgentId: string | null;
      assigneeUserId: string | null;
    };
    runId: string;
    actorAgentId: string | null;
    responsibleUserId?: string | null;
    driverKind?: string | null;
    contextSnapshot?: unknown;
    runnerProfileJson?: unknown;
    targetAgentId: string;
    unblockAction: string;
    requireTaskOwner?: boolean;
    lockSources?: boolean;
  },
): Promise<BlockerHandoffEligibility> {
  if (!input.actorAgentId) {
    return {
      allowed: false,
      reason: "not_task_owner",
      message: "Only the task's current assignee can hand this task off to another agent.",
    };
  }
  if (
    input.requireTaskOwner &&
    (input.issue.assigneeUserId || input.issue.assigneeAgentId !== input.actorAgentId)
  ) {
    return {
      allowed: false,
      reason: "not_task_owner",
      message: "Only the task's current assignee can hand this task off to another agent.",
    };
  }
  if (isConversation(input.issue) || await hasExternalChatBinding(db, input.companyId, input.issue.id)) {
    return {
      allowed: false,
      reason: "conversation_or_chat_locked",
      message: 'This task is bound to a conversation or external chat channel, so its agent assignment cannot be handed off to another agent. Create a separate task for that agent or report a person-owned blocker with kind "user".',
    };
  }
  const agentQuery = db.select().from(agents).where(and(
    eq(agents.id, input.targetAgentId),
    eq(agents.companyId, input.companyId),
  )).limit(1);
  const [ownerAgent] = await (input.lockSources ? agentQuery.for("share", { noWait: true }) : agentQuery);
  if (!ownerAgent || ownerAgent.status === "terminated" || !(await evaluateAgentInvokabilityFromDb(db, ownerAgent)).invokable) {
    return {
      allowed: false,
      reason: "unavailable",
      message: "The named blocker owner is not available in this company. Choose an available agent or name a person.",
    };
  }
  try {
    await assertAssignableAgent(db, input.companyId, input.targetAgentId, { kind: "work" });
  } catch (error) {
    if (error instanceof HttpError) {
      return {
        allowed: false,
        reason: "unassignable",
        message: `The named blocker owner cannot be assigned this task: ${error.message}. Choose an available agent or name a person.`,
      };
    }
    throw error;
  }
  const externalAuthorizer = await resolveExternalRunAuthorizingUser(db, {
    companyId: input.companyId,
    agentId: input.actorAgentId,
    driverKind: input.driverKind,
    runnerProfileJson: input.runnerProfileJson,
  });
  if (externalAuthorizer.status === "unavailable") {
    return {
      allowed: false,
      reason: "unauthorized",
      message: "The named blocker owner cannot be assigned this task: external run authorizer is unavailable. Choose another agent or name a person.",
    };
  }
  const actor: AuthorizationActor = {
    type: "agent",
    agentId: input.actorAgentId,
    companyId: input.companyId,
    runId: input.runId,
    source: "agent_jwt",
    onBehalfOfUserId: input.responsibleUserId ?? null,
    keyScope: nativeRunKeyScope({
      issueId: input.issue.id,
      workMode: input.issue.workMode,
      contextSnapshot: input.contextSnapshot,
    }),
    ...(externalAuthorizer.status === "authorized"
      ? { authorizingUserId: externalAuthorizer.userId }
      : {}),
  };
  const authDecision = await authorizationService(db).decide(
    {
      actor,
      action: "tasks:assign",
      resource: {
        type: "issue",
        companyId: input.companyId,
        issueId: input.issue.id,
        projectId: input.issue.projectId,
        parentIssueId: input.issue.parentId,
        assigneeAgentId: input.targetAgentId,
        assigneeUserId: null,
        status: input.issue.status,
      },
      scope: {
        issueId: input.issue.id,
        projectId: input.issue.projectId,
        parentIssueId: input.issue.parentId,
        assigneeAgentId: input.targetAgentId,
        assigneeUserId: null,
      },
    },
    { interactionPolicy: "defer_to_mutation" },
  );
  if (!authDecision.allowed) {
    return {
      allowed: false,
      reason: "unauthorized",
      message: `The named blocker owner cannot be assigned this task: ${authDecision.explanation} Choose another agent or name a person.`,
    };
  }
  const denial = await agentInteractionDenial(db, {
    companyId: input.companyId,
    actorAgentId: input.actorAgentId,
    operation: "assign",
    issueId: input.issue.id,
    targetAgentId: input.targetAgentId,
    texts: [input.unblockAction],
    lock: input.lockSources,
  });
  if (denial) {
    return {
      allowed: false,
      reason: "interaction_denied",
      message: `The named blocker owner cannot receive this task: agent interaction is disabled by ${denial.permission}. Choose another agent or name a person.`,
    };
  }
  return { allowed: true };
}
