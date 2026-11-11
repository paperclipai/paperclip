import { and, eq, isNull } from "drizzle-orm";
import { issueThreadInteractions, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { issueThreadInteractionAttentionAgentAllowed } from "./issue-thread-interaction-resolution.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function isVerifiedPendingAddresseeInteraction(db: Pick<Db, "select">, input: {
  companyId: string; issueId: string; agentId: string; context: unknown;
}): Promise<boolean> {
  const context = record(input.context);
  const id = typeof context.interactionId === "string" && isUuidLike(context.interactionId) ? context.interactionId : null;
  if (!id) return false;
  if (context.wakeReason !== "interaction_pending" && context.source !== "issue.interaction.created") return false;
  const [interaction] = await db.select({
    kind: issueThreadInteractions.kind,
    payload: issueThreadInteractions.payload,
    createdByAgentId: issueThreadInteractions.createdByAgentId,
    createdByUserId: issueThreadInteractions.createdByUserId,
    sourceRunId: issueThreadInteractions.sourceRunId,
    addresseeAgentId: issueThreadInteractions.addresseeAgentId,
    addresseeUserId: issueThreadInteractions.addresseeUserId,
    effectiveResolverPolicy: issueThreadInteractions.effectiveResolverPolicy,
    resolverPolicyProvenance: issueThreadInteractions.resolverPolicyProvenance,
  }).from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.id, id),
    eq(issueThreadInteractions.companyId, input.companyId),
    eq(issueThreadInteractions.issueId, input.issueId),
    eq(issueThreadInteractions.status, "pending"),
    isNull(issueThreadInteractions.dismissedAt),
    eq(issueThreadInteractions.addresseeAgentId, input.agentId),
  )).limit(1);
  if (!interaction) return false;
  const payload = record(interaction.payload);
  return issueThreadInteractionAttentionAgentAllowed({
    agentId: input.agentId,
    interaction,
    governedAction: interaction.kind === "request_confirmation" && payload.toolAction !== undefined,
  });
}
