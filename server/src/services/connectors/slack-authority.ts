import {
  heartbeatRuns,
  runIdentityContexts,
  toolInvocations,
  toolActionRequests,
  type Db,
  chatEndpoints,
  type chatConversations,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import { captureRunIdentity } from "../run-identity.js";
import { forbidden } from "../../errors.js";
import { boundRunIssueId } from "../run-task-binding.js";
import { chatRunSourceMessageId } from "../chat-channels/run-origin.js";

export interface SlackTaskBinding {
  companyId: string;
  agentId: string;
  runId: string;
  issueId: string;
  workMode?: string;
  /** Selects a server-verified connection assigned to this agent. */
  endpointId?: string;
  /** Controller-only operation snapshot; never part of a tool argument schema. */
  identityContextId?: string | null;
  approvedInvocationId?: string;
}
export interface SlackTaskAuthority {
  endpoint: typeof chatEndpoints.$inferSelect;
  issueId: string;
  conversation: typeof chatConversations.$inferSelect | null;
  userId: string;
  slackUserId: string;
  principalId: string;
  deliveryId: string | null;
  identityContextId: string | null;
  revision: string;
  workMode: string;
  botToken: string;
  searchActionToken?: string | null;
}
export type SlackTaskAuthorization = Omit<SlackTaskAuthority, "revision" | "searchActionToken">;
// Only the live chat service can attest to admission. JSON snapshots, model
// arguments and credential possession cannot install an authority callback.
const authorities = new WeakMap<
  Db,
  {
    resolve: (binding: SlackTaskBinding) => Promise<SlackTaskAuthority>;
    authorize?: (binding: SlackTaskBinding) => Promise<SlackTaskAuthorization>;
  }
>();
export function registerSlackTaskAuthority(
  db: Db,
  resolve: (binding: SlackTaskBinding) => Promise<SlackTaskAuthority>,
  authorize?: (binding: SlackTaskBinding) => Promise<SlackTaskAuthorization>,
) {
  const registration = { resolve, authorize };
  authorities.set(db, registration);
  return () => {
    if (authorities.get(db) === registration) authorities.delete(db);
  };
}
export async function resolveSlackTaskAuthority(
  db: Db,
  binding: SlackTaskBinding,
) {
  const registration = authorities.get(db);
  if (!registration) throw forbidden("Slack task authority is unavailable");
  const resolve = registration.resolve;
  return resolve(binding);
}
export async function resolveSlackTaskAuthorization(
  db: Db,
  binding: SlackTaskBinding,
): Promise<SlackTaskAuthorization> {
  const registration = authorities.get(db);
  if (!registration) throw forbidden("Slack task authority is unavailable");
  return (registration.authorize ?? registration.resolve)(binding);
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
    boundRunIssueId(captured.run) !== binding.issueId ||
    !captured.run.responsibleUserId
  )
    throw forbidden(
      "Slack tools require the bound task and an accepted linked user",
    );
  return { ...captured, sourceMessageId: await chatRunSourceMessageId(db, captured.run, { context: captured.context }) };
}

/** Enumerate only this agent's connections; each still needs live run/user authority. */
export async function slackEndpointCandidates(
  db: Db,
  binding: Pick<SlackTaskBinding, "companyId" | "agentId" | "endpointId">,
) {
  return db
    .select({ id: chatEndpoints.id, connectionId: chatEndpoints.connectionId })
    .from(chatEndpoints)
    .where(
      and(
        eq(chatEndpoints.companyId, binding.companyId),
        eq(chatEndpoints.assignedAgentId, binding.agentId),
        eq(chatEndpoints.provider, "slack"),
        inArray(chatEndpoints.status, ["active", "verifying"]),
        ...(binding.endpointId
          ? [eq(chatEndpoints.id, binding.endpointId)]
          : []),
      ),
    );
}
