import { notifyChatConfirmationResolution } from "./chat-confirmation-notifications.js";
import { enqueueTerminalIssueInteractionChatPublications } from "./chat-interaction-publications.js";
import { connectionManagementService } from "./connection-management.js";
import { chatCredentialEntryGenerations } from "./chat-channels/credentials.js";
import { and, asc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { approvals, chatEndpoints, chatExternalPrincipals, chatIdentityLinks, toolConnections, companyMemberships, connectionIntentDeliveries, issueApprovals, issueThreadInteractions, issues, type Db } from "@paperclipai/db";
import { connectionIntentPayloadSchema } from "@paperclipai/shared";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { chatCredentialRotationId, connectionIntentService } from "./connection-intents.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";
import { logger } from "../middleware/logger.js";
import { createToolGatewayService } from "./tool-gateway.js";

type Task = Pick<typeof issues.$inferSelect, "id" | "companyId" | "projectId" | "status" | "assigneeAgentId" | "assigneeUserId">;
type Intent = Pick<typeof issueThreadInteractions.$inferSelect, "id" | "companyId" | "issueId" | "kind" | "status" | "payload" | "addresseeUserId"> & Partial<Pick<typeof issueThreadInteractions.$inferSelect, "sourceRunId">>;

/** Verify existing access only. This never installs tools, grants access, or adopts an identity. */
async function findAvailableToolConnection(db: Db, task: Task, intent: Intent, policyRunId?: string | null) {
  if (intent.kind !== "connection_intent" || intent.status !== "pending"
    || intent.companyId !== task.companyId || intent.issueId !== task.id
    || task.assigneeUserId) return null;
  const parsed = connectionIntentPayloadSchema.safeParse(intent.payload);
  if (!parsed.success) return null;
  const payload = parsed.data;
  if (payload.savedSetup && payload.purpose === "channel") {
    if (payload.requestingAgentId !== task.assigneeAgentId || !intent.addresseeUserId) return null;
    const [endpoint] = await db.select().from(chatEndpoints).where(and(eq(chatEndpoints.id, payload.savedSetup.endpointId),
      eq(chatEndpoints.companyId, task.companyId), eq(chatEndpoints.connectionId, payload.savedSetup.connectionId),
      eq(chatEndpoints.assignedAgentId, payload.requestingAgentId), eq(chatEndpoints.status, "active")));
    if (!endpoint || endpoint.sponsorUserId !== intent.addresseeUserId) return null;
    const [connection] = await db.select().from(toolConnections).where(and(eq(toolConnections.id, endpoint.connectionId),
      eq(toolConnections.companyId, task.companyId), eq(toolConnections.status, "active"), eq(toolConnections.enabled, true)));
    if (!connection || !["ok", "healthy"].includes(connection.healthStatus)) return null;
    if (payload.savedSetup.action === "confirm_identity") {
      if (!endpoint.providerAccountId) return null;
      const [link] = await db.select({ id: chatIdentityLinks.id }).from(chatIdentityLinks)
        .innerJoin(chatExternalPrincipals, and(eq(chatExternalPrincipals.id, chatIdentityLinks.principalId),
          eq(chatExternalPrincipals.companyId, chatIdentityLinks.companyId)))
        .where(and(eq(chatIdentityLinks.companyId, task.companyId), eq(chatIdentityLinks.endpointId, endpoint.id),
          eq(chatIdentityLinks.paperclipUserId, intent.addresseeUserId), eq(chatIdentityLinks.status, "linked"),
          eq(chatExternalPrincipals.provider, endpoint.provider), eq(chatExternalPrincipals.providerAccountId, endpoint.providerAccountId)))
        .limit(1);
      if (!link) return null;
    }
    if (payload.savedSetup.action === "enter_credentials") {
      const proof = payload.savedSetup.credentialEntry;
      if (!proof) return null;
      const generations = chatCredentialEntryGenerations(endpoint.setup);
      const fields = Object.keys(proof.previousGenerations);
      const changed = fields.filter(field => typeof generations[field] === "string" && generations[field] !== proof.previousGenerations[field]);
      if (!changed.length || (proof.requireAll && changed.length !== fields.length)) return null;
      if (changed.some(field => field === "signingSecret" || field === "webhookSecret") && !endpoint.setup.webhookVerifiedAt) return null;
    }
    if (payload.savedSetup.credentialRotation) {
      // Rotation commits its generation and clears webhook verification in the
      // same transaction as vault refs. Old health cannot satisfy this request.
      const generation = chatCredentialRotationId(endpoint.setup);
      if (!generation || generation === payload.savedSetup.credentialRotation.previousId || !endpoint.setup.webhookVerifiedAt) return null;
    }
    const capability = await connectionManagementService(db).capability({ type: "agent", agentId: payload.requestingAgentId,
      companyId: task.companyId, onBehalfOfUserId: intent.addresseeUserId }, "connections:configure", {
      type: "connection_management", companyId: task.companyId, connectionId: connection.id, projectId: task.projectId,
      issueId: task.id, targetAgentId: payload.requestingAgentId, purpose: "chat", operation: "chat.authentication_handoff",
    });
    return capability.allowed ? connection : null;
  }
  // Additional permissions, provider authentication and inbox setup still need
  // their governed completion paths. Aggregator cards also name an upstream app.
  if (payload.purpose || payload.accessRequest || payload.upstreamService
    || payload.requestingAgentId !== task.assigneeAgentId || !intent.addresseeUserId) return null;
  if (intent.addresseeUserId !== "local-board") {
    const [membership] = await db.select().from(companyMemberships).where(and(
      eq(companyMemberships.companyId, task.companyId), eq(companyMemberships.principalType, "user"),
      eq(companyMemberships.principalId, intent.addresseeUserId),
    ));
    if (membership?.status !== "active" || !membership.membershipRole || membership.membershipRole === "viewer") return null;
  }
  const connection = await connectionIntentService(db).usableConnectionForAgent({ companyId: task.companyId,
    agentId: payload.requestingAgentId, responsibleUserId: intent.addresseeUserId, serviceSlug: payload.serviceSlug });
  if (!connection) return null;
  // Use the gateway's exact descriptors and listing policy, including task,
  // project and routine context. Per-invocation approvals remain enforced.
  const access = await createToolGatewayService(db).summarizeConnectionAccessForAgent({
    companyId: task.companyId, connectionId: connection.id, agentId: payload.requestingAgentId,
    heartbeatRunId: policyRunId === undefined ? intent.sourceRunId ?? null : policyRunId,
    issueId: task.id, projectId: task.projectId,
  });
  return access.allowedCount + access.askFirstCount > 0 ? connection : null;
}

export async function findSatisfiedToolConnection(db: Db, task: Task, intent: Intent, policyRunId?: string | null) {
  if (!["in_progress", "in_review"].includes(task.status)) return null;
  return findAvailableToolConnection(db, task, intent, policyRunId);
}

/** Recheck both live requests and system-retired cards against the next run. */
export async function connectionContinuationPendingResponse(db: Db, task: Task, responsibleUserId: string | null,
  policyRunId?: string | null): Promise<"interaction" | "approval" | null> {
  const interactions = await db.select().from(issueThreadInteractions).where(and(
    eq(issueThreadInteractions.companyId, task.companyId), eq(issueThreadInteractions.issueId, task.id),
    or(eq(issueThreadInteractions.status, "pending"), and(eq(issueThreadInteractions.kind, "connection_intent"), eq(issueThreadInteractions.status, "expired"))),
  ));
  for (const interaction of interactions) {
    const retired = interaction.status === "expired" && interaction.result?.outcome === "expired"
      && "connectionId" in interaction.result && typeof interaction.result.connectionId === "string";
    if (interaction.status !== "pending" && !retired) continue;
    if (retired && (interaction.payload as { requestingAgentId?: string }).requestingAgentId !== task.assigneeAgentId) continue;
    if (interaction.addresseeUserId !== responsibleUserId) return "interaction";
    const connection = await findAvailableToolConnection(db, task, { ...interaction, status: "pending" }, policyRunId);
    // Historical system retirements describe a service need, not a permanent
    // binding to an account the user may later replace. Delivery and native
    // response projection still validate their own exact recorded connection.
    if (!connection) return "interaction";
  }
  const [approval] = await db.select({ id: approvals.id }).from(issueApprovals).innerJoin(approvals, and(
    eq(approvals.id, issueApprovals.approvalId), eq(approvals.companyId, issueApprovals.companyId),
  )).where(and(eq(issueApprovals.companyId, task.companyId), eq(issueApprovals.issueId, task.id),
    inArray(approvals.status, ["pending", "revision_requested"]))).limit(1);
  return approval ? "approval" : null;
}

export function satisfiedConnectionIntentService(db: Db) {
  let afterId: string | null = null;
  return {
    async sweepPending() {
      const candidates = await db.select({ id: issueThreadInteractions.id, issueId: issues.id, companyId: issues.companyId })
        .from(issueThreadInteractions).innerJoin(issues, and(
          eq(issues.id, issueThreadInteractions.issueId), eq(issues.companyId, issueThreadInteractions.companyId),
        )).where(and(eq(issueThreadInteractions.kind, "connection_intent"), eq(issueThreadInteractions.status, "pending"),
          inArray(issues.status, ["in_progress", "in_review"]), isNull(issues.assigneeUserId),
          ...(afterId ? [gt(issueThreadInteractions.id, afterId)] : [])))
        .orderBy(asc(issueThreadInteractions.id)).limit(50);
      // Rotate past unavailable cards so they cannot starve a later ready one.
      afterId = candidates.length === 50 ? candidates[49]!.id : null;
      let satisfied = 0;
      let failed = 0;
      for (const candidate of candidates) {
        const publications: ActivityPublication[] = [];
        try {
          const updated = await db.transaction(async (tx) => {
            const txDb = tx as unknown as Db;
            const [task] = await tx.select().from(issues).where(and(
              eq(issues.id, candidate.issueId), eq(issues.companyId, candidate.companyId),
            )).for("update");
            const [intent] = await tx.select().from(issueThreadInteractions).where(and(
              eq(issueThreadInteractions.id, candidate.id), eq(issueThreadInteractions.companyId, candidate.companyId),
              eq(issueThreadInteractions.issueId, candidate.issueId),
            )).for("update");
            if (!task || !intent) return false;
            if (intent.addresseeUserId && intent.addresseeUserId !== "local-board") {
              await tx.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
                eq(companyMemberships.companyId, candidate.companyId), eq(companyMemberships.principalType, "user"),
                eq(companyMemberships.principalId, intent.addresseeUserId),
              )).for("share");
            }
            const connection = await findSatisfiedToolConnection(txDb, task, intent);
            if (!connection) return false;
            const now = new Date();
            // Retire the obsolete request without inventing a human approval.
            await notifyChatConfirmationResolution(tx, intent);
            const [retired] = await tx.update(issueThreadInteractions).set({ status: "expired", resolvedAt: now, updatedAt: now,
              result: { version: 1, outcome: "expired", connectionId: connection.id,
                reason: "An already authorized connection is available to the requesting agent." },
            }).where(and(eq(issueThreadInteractions.id, intent.id), eq(issueThreadInteractions.status, "pending"))).returning();
            if (!retired) return false;
            const { issueThreadInteractionService } = await import("./issue-thread-interactions.js");
            const interaction = await issueThreadInteractionService(txDb).getById(retired.id);
            if (interaction) await enqueueTerminalIssueInteractionChatPublications(txDb, interaction);
            await tx.update(issues).set({ updatedAt: now }).where(and(eq(issues.id, task.id), eq(issues.companyId, task.companyId)));
            await tx.insert(connectionIntentDeliveries).values({ interactionId: intent.id, companyId: task.companyId }).onConflictDoNothing();
            await notifyDeliveryWork(tx, DELIVERY_QUEUES.connection);
            await logActivity(txDb, { companyId: task.companyId, actorType: "system", actorId: "connection-reconciliation",
              action: "issue.thread_interaction_resolved", entityType: "issue", entityId: task.id,
              details: { interactionId: intent.id, interactionKind: "connection_intent", status: "expired",
                connectionId: connection.id, resolutionSource: "existing_connection" },
            }, publications);
            return true;
          });
          for (const publication of publications) publishActivity(publication);
          if (updated) satisfied += 1;
        } catch (error) {
          failed += 1;
          logger.warn({ err: error, interactionId: candidate.id }, "Could not reconcile an already available connection");
        }
      }
      return { scanned: candidates.length, satisfied, failed };
    },
  };
}
