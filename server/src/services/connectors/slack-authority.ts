import {
  heartbeatRuns,
  runIdentityContexts,
  toolInvocations,
  toolActionRequests,
  type Db,
  type chatEndpoints,
  type chatConversations,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { captureRunIdentity } from "../run-identity.js";
import { forbidden } from "../../errors.js";

export interface SlackTaskBinding {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string;
  workMode?: string;
  /** Controller-only operation snapshot; never part of a tool argument schema. */
  identityContextId?: string | null;
  approvedInvocationId?: string;
}
export interface SlackTaskAuthority {
  endpoint: typeof chatEndpoints.$inferSelect;
  conversation: typeof chatConversations.$inferSelect;
  userId: string;
  slackUserId: string;
  principalId: string;
  deliveryId: string;
  identityContextId: string | null;
  revision: string;
  workMode: string;
  botToken: string;
  searchActionToken?: string | null;
}
// Only the live chat service can attest to admission. JSON snapshots, model
// arguments and credential possession cannot install an authority callback.
const authorities = new WeakMap<
  Db,
  (binding: SlackTaskBinding) => Promise<SlackTaskAuthority>
>();
export function registerSlackTaskAuthority(
  db: Db,
  resolve: (binding: SlackTaskBinding) => Promise<SlackTaskAuthority>,
) {
  authorities.set(db, resolve);
  return () => {
    if (authorities.get(db) === resolve) authorities.delete(db);
  };
}
export async function resolveSlackTaskAuthority(
  db: Db,
  binding: SlackTaskBinding,
) {
  const resolve = authorities.get(db);
  if (!resolve) throw forbidden("Slack task authority is unavailable");
  return resolve(binding);
}

/** Follow only immutable controller provenance, stopping at the latest human message.
 * A board-authored message must not inherit an earlier Slack user's credentials. */
export async function slackRunOrigin(db: Db, binding: SlackTaskBinding) {
  let captured;
  if (binding.approvedInvocationId) {
    const [approved] = await db
      .select({ invocation: toolInvocations })
      .from(toolInvocations)
      .innerJoin(
        toolActionRequests,
        and(
          eq(toolActionRequests.invocationId, toolInvocations.id),
          eq(toolActionRequests.companyId, binding.companyId),
        ),
      )
      .where(
        and(
          eq(toolInvocations.companyId, binding.companyId),
          eq(toolInvocations.id, binding.approvedInvocationId),
          eq(toolInvocations.runId, binding.runId),
          eq(toolInvocations.issueId, binding.issueId),
          eq(toolInvocations.agentId, binding.agentId),
          inArray(toolActionRequests.status, [
            "pending",
            "approved",
            "executing",
          ]),
        ),
      );
    if (!approved || !binding.identityContextId)
      throw forbidden("Slack approval is not executing for this task");
    const [run] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, binding.companyId),
          eq(heartbeatRuns.id, binding.runId),
          eq(heartbeatRuns.agentId, binding.agentId),
        ),
      );
    const [context] = await db
      .select()
      .from(runIdentityContexts)
      .where(
        and(
          eq(runIdentityContexts.companyId, binding.companyId),
          eq(runIdentityContexts.id, binding.identityContextId),
          eq(runIdentityContexts.runId, binding.runId),
          eq(runIdentityContexts.status, "accepted"),
        ),
      );
    if (
      !run ||
      !context ||
      context.responsibleUserId !== run.responsibleUserId ||
      run.activeIdentityContextId !== context.id
    )
      throw forbidden(
        "The accepted requester changed after Slack approval was requested",
      );
    captured = { run, context };
  } else {
    captured = await captureRunIdentity(db, binding);
    if (
      binding.identityContextId &&
      binding.identityContextId !== captured.context?.id
    )
      throw forbidden(
        "The accepted requester changed before the Slack operation executed",
      );
  }
  if (
    (captured.run.contextSnapshot?.issueId ??
      captured.run.contextSnapshot?.taskId) !== binding.issueId ||
    !captured.run.responsibleUserId
  )
    throw forbidden(
      "Slack tools require the bound task and an accepted linked user",
    );
  let origin = captured.context;
  const seen = new Set<string>();
  while (origin && !origin.messageId && origin.parentContextId) {
    if (seen.has(origin.id) || seen.size >= 100)
      throw forbidden("Slack source provenance could not be verified");
    seen.add(origin.id);
    const [parent] = await db
      .select()
      .from(runIdentityContexts)
      .where(
        and(
          eq(runIdentityContexts.id, origin.parentContextId),
          eq(runIdentityContexts.companyId, binding.companyId),
          eq(runIdentityContexts.status, "accepted"),
        ),
      );
    if (!parent || parent.responsibleUserId !== captured.run.responsibleUserId)
      throw forbidden("Slack requester provenance changed");
    // Delegation to a different task does not grant that task Slack tools.
    const [sourceRun] = await db
      .select()
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, parent.runId),
          eq(heartbeatRuns.companyId, binding.companyId),
          eq(heartbeatRuns.agentId, binding.agentId),
        ),
      );
    if (
      !sourceRun ||
      (sourceRun.contextSnapshot?.issueId ??
        sourceRun.contextSnapshot?.taskId) !== binding.issueId
    )
      throw forbidden("Slack tools cannot be inherited by another task");
    origin = parent;
  }
  return { ...captured, sourceMessageId: origin?.messageId ?? null };
}
