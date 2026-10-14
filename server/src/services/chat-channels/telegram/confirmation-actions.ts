import type { DbTransaction, RuntimeContext, LifecycleRuntimeFence } from "../runtime-types.js";

import { notifyChatPublicationWork } from "../../chat-work-notifications.js";

import {
  and,
  asc,
  eq,
  inArray,
  ne,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatEndpoints,
  chatExternalPrincipals,
  chatPublications,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";

import {
  type ChatSdkCallbackEvent,
} from "../../chat-sdk-runtime.js";

import {
  logActivity,
} from "../../activity-log.js";

import { projectSafeChatPublication } from "../../chat-publication-projection.js";

import { issueThreadInteractionService } from "../../issue-thread-interactions.js";

import type { EndpointRecord } from "../runtime-types.js";
import type { ActionEvent } from "chat";
import { nativeTelegramConfirmation } from "../../chat-interaction-publications.js";
type TelegramConfirmationInput = {
  record: EndpointRecord;
  event: ChatSdkCallbackEvent<ActionEvent>;
  runtimeContext: RuntimeContext;
  conversation: typeof chatConversations.$inferSelect;
  principal: { principal: typeof chatExternalPrincipals.$inferSelect; userId: string };
  issued: { publication: typeof chatPublications.$inferSelect };
  interaction: Awaited<ReturnType<ReturnType<typeof issueThreadInteractionService>["listForIssue"]>>[number];
  deny: (known?: { conversationId?: string | null; principalId?: string | null }) => Promise<void>;
  safelyKnown: { conversationId: string; principalId: string };
};
type TelegramConfirmationOptions = {
  requireCurrentExternalActionAuthorization: (tx: DbTransaction, input: { conversationId: string; endpointId: string; expectedUserId: string; principalId: string; runtimeContext: LifecycleRuntimeFence }) => Promise<void>;
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  processPendingPublications: () => Promise<unknown>;
  confirmationResolutionPersistBarrier?: () => Promise<void>;
};
export function createTelegramConfirmationActions(db: Db, options: TelegramConfirmationOptions) {
  const { requireCurrentExternalActionAuthorization, isExternalActionAuthorizationChange, scheduleMessageProcessing, processPendingPublications } = options;
  async function handleTelegramConfirmation(input: TelegramConfirmationInput) {
    const { record, event, runtimeContext, conversation, principal, issued, interaction, deny, safelyKnown } = input;

    if (
      event.provider !== "telegram" ||
      !nativeTelegramConfirmation(interaction)
    ) {
      return deny(safelyKnown);
    }
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.companyId, record.endpoint.companyId),
          eq(chatActions.endpointId, record.endpoint.id),
          eq(chatActions.conversationId, conversation.id),
          eq(chatActions.kind, "confirmation_response"),
          eq(chatActions.providerActionId, event.event.actionId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!action || action.status !== "issued") return deny(safelyKnown);
    const tokenPayload = action.payload;
    const tokenExpiresAt =
      typeof tokenPayload.expiresAt === "string"
        ? Date.parse(tokenPayload.expiresAt)
        : Number.NaN;
    if (!Number.isFinite(tokenExpiresAt) || tokenExpiresAt <= Date.now()) {
      await db
        .update(chatActions)
        .set({
          status: "expired",
          result: { code: "confirmation_action_token_expired" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "issued"),
          ),
        );
      return deny(safelyKnown);
    }
    if (
      tokenPayload.version !== 1 ||
      tokenPayload.publicationId !== issued.publication.id ||
      tokenPayload.interactionId !== interaction.id ||
      (tokenPayload.decision !== "accept" &&
        tokenPayload.decision !== "reject")
    ) {
      return deny(safelyKnown);
    }

    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        projectId: issues.projectId,
        goalId: issues.goalId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, record.endpoint.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue) {
      return deny(safelyKnown);
    }

    const decision = tokenPayload.decision;
    try {
      if (decision === "accept") {
        await issueThreadInteractionService(db).acceptInteraction(
          issue,
          interaction.id,
          {},
          { userId: principal.userId },
          {
            beforeResolveInTransaction: async (tx) => {
              await requireCurrentExternalActionAuthorization(tx, {
                conversationId: conversation.id,
                endpointId: record.endpoint.id,
                expectedUserId: principal.userId!,
                principalId: principal.principal.id,
                runtimeContext,
              });
            },
            afterResolveInTransaction: async (tx, resolved) => {
              const [owned] = await tx
                .update(chatActions)
                .set({
                  principalId: principal.principal.id,
                  status: "processing",
                  payload: {
                    ...tokenPayload,
                    messageId: event.event.messageId,
                    actionId: event.event.actionId,
                    value: null,
                  },
                  result: {
                    code: "confirmation_resolution_committed_by_provider",
                    interactionId: resolved.id,
                    interactionStatus: resolved.status,
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, action.id),
                    eq(chatActions.status, "issued"),
                  ),
                )
                .returning({ id: chatActions.id });
              if (!owned) {
                throw new Error(
                  "External confirmation action ownership changed before interaction commit",
                );
              }
            },
          },
        );
      } else {
        await issueThreadInteractionService(db).rejectInteraction(
          issue,
          interaction.id,
          {},
          { userId: principal.userId },
          {
            beforeResolveInTransaction: async (tx) => {
              await requireCurrentExternalActionAuthorization(tx, {
                conversationId: conversation.id,
                endpointId: record.endpoint.id,
                expectedUserId: principal.userId!,
                principalId: principal.principal.id,
                runtimeContext,
              });
            },
            afterResolveInTransaction: async (tx, resolved) => {
              const [owned] = await tx
                .update(chatActions)
                .set({
                  principalId: principal.principal.id,
                  status: "processing",
                  payload: {
                    ...tokenPayload,
                    messageId: event.event.messageId,
                    actionId: event.event.actionId,
                    value: null,
                  },
                  result: {
                    code: "confirmation_resolution_committed_by_provider",
                    interactionId: resolved.id,
                    interactionStatus: resolved.status,
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, action.id),
                    eq(chatActions.status, "issued"),
                  ),
                )
                .returning({ id: chatActions.id });
              if (!owned) {
                throw new Error(
                  "External confirmation action ownership changed before interaction commit",
                );
              }
            },
          },
        );
      }
    } catch (error) {
      if (isExternalActionAuthorizationChange(error)) {
        return deny(safelyKnown);
      }
      const currentStatus = await db
        .select({ status: issueThreadInteractions.status })
        .from(issueThreadInteractions)
        .where(eq(issueThreadInteractions.id, interaction.id))
        .then((rows) => rows[0]?.status ?? null);
      if (currentStatus !== null && currentStatus !== "pending") {
        await settleTerminalConfirmationAction(action.id);
        const completedAction = await db
          .select({ status: chatActions.status, result: chatActions.result })
          .from(chatActions)
          .where(eq(chatActions.id, action.id))
          .then((rows) => rows[0] ?? null);
        if (
          completedAction?.status === "processed" &&
          completedAction.result?.code ===
            "confirmation_resolution_committed_by_provider"
        ) {
          return;
        }
        return deny(safelyKnown);
      }
      throw error;
    }

    await options.confirmationResolutionPersistBarrier?.();
    if (!(await settleTerminalConfirmationAction(action.id))) {
      throw new Error(
        "External confirmation action ownership changed before settlement",
      );
    }

    scheduleMessageProcessing(async () => {
      await processPendingPublications();
    });
    return;

  }


  async function settleTerminalConfirmationAction(
    actionId: string,
  ): Promise<boolean> {
    const action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "confirmation_response"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (action?.status === "processed") return true;
    if (!action || action.status !== "processing" || !action.conversationId)
      return false;
    const token = action.payload;
    if (
      token.version !== 1 ||
      typeof token.publicationId !== "string" ||
      typeof token.interactionId !== "string" ||
      (token.decision !== "accept" && token.decision !== "reject")
    ) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "confirmation_action_payload_invalid" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    const [conversation, publication, endpoint] = await Promise.all([
      db
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.companyId, action.companyId),
            eq(chatConversations.endpointId, action.endpointId),
            eq(chatConversations.id, action.conversationId),
          ),
        )
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(chatPublications)
        .where(
          and(
            eq(chatPublications.companyId, action.companyId),
            eq(chatPublications.endpointId, action.endpointId),
            eq(chatPublications.id, token.publicationId as string),
          ),
        )
        .then((rows) => rows[0] ?? null),
      db
        .select()
        .from(chatEndpoints)
        .where(
          and(
            eq(chatEndpoints.companyId, action.companyId),
            eq(chatEndpoints.id, action.endpointId),
          ),
        )
        .then((rows) => rows[0] ?? null),
    ]);
    if (
      !conversation ||
      !publication ||
      !endpoint ||
      endpoint.provider !== "telegram" ||
      publication.conversationId !== conversation.id ||
      publication.payload.interactionId !== token.interactionId
    ) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "confirmation_action_binding_invalid" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    const interaction = (
      await issueThreadInteractionService(db).listForIssue(conversation.issueId)
    ).find((candidate) => candidate.id === token.interactionId);
    if (
      !interaction ||
      interaction.kind !== "request_confirmation" ||
      !nativeTelegramConfirmation(interaction)
    ) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "confirmation_interaction_invalid" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    if (
      interaction.status !== "accepted" &&
      interaction.status !== "rejected"
    ) {
      if (interaction.status === "pending") return false;
      const [retired] = await db
        .update(chatActions)
        .set({
          status: "expired",
          result: {
            code: "confirmation_interaction_resolved_elsewhere",
            interactionId: interaction.id,
            interactionStatus: interaction.status,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        )
        .returning({ id: chatActions.id });
      if (retired) return true;
      const winner = await db
        .select({ status: chatActions.status })
        .from(chatActions)
        .where(eq(chatActions.id, action.id))
        .then((rows) => rows[0] ?? null);
      return winner?.status === "expired" || winner?.status === "processed";
    }
    const decisionMatches =
      (token.decision === "accept" && interaction.status === "accepted") ||
      (token.decision === "reject" && interaction.status === "rejected");
    if (!decisionMatches) {
      await db
        .update(chatActions)
        .set({
          status: "expired",
          result: { code: "interaction_resolved_by_sibling_action" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    const issue = await db
      .select({
        id: issues.id,
        companyId: issues.companyId,
        assigneeAgentId: issues.assigneeAgentId,
        status: issues.status,
      })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, action.companyId),
          eq(issues.id, conversation.issueId),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!issue || !interaction.resolvedByUserId) {
      await db
        .update(chatActions)
        .set({
          status: "failed",
          result: { code: "confirmation_resolution_context_missing" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        );
      return false;
    }
    const resolvedByUserId = interaction.resolvedByUserId;
    const shouldWake =
      Boolean(issue.assigneeAgentId) &&
      issue.status !== "done" &&
      issue.status !== "cancelled" &&
      (interaction.continuationPolicy === "wake_assignee" ||
        (interaction.continuationPolicy === "wake_assignee_on_accept" &&
          interaction.status === "accepted"));
    const resolutionLabel =
      interaction.status === "accepted" ? "Accepted" : "Rejected";
    const resolvedByThisProviderAction =
      action.result?.code === "confirmation_resolution_committed_by_provider";
    return db.transaction(async (tx) => {
      const [completed] = await tx
        .update(chatActions)
        .set({
          status: "processed",
          result: {
            code: resolvedByThisProviderAction
              ? "confirmation_resolution_committed_by_provider"
              : "confirmation_resolution_reconciled",
            interactionId: interaction.id,
            interactionStatus: interaction.status,
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.status, "processing"),
          ),
        )
        .returning({ id: chatActions.id });
      if (!completed) {
        // A publication sweep may reconcile the durable action while the
        // original provider callback is still in flight. Treat that CAS loss
        // as success once the winner has processed the same action so the
        // provider does not receive a spurious 5xx and redeliver it.
        const winner = await tx
          .select({ status: chatActions.status })
          .from(chatActions)
          .where(eq(chatActions.id, action.id))
          .then((rows) => rows[0] ?? null);
        return winner?.status === "processed";
      }
      await tx
        .update(chatActions)
        .set({
          status: "expired",
          result: { code: "interaction_resolved_by_sibling_action" },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.companyId, issue.companyId),
            eq(chatActions.endpointId, action.endpointId),
            eq(chatActions.conversationId, conversation.id),
            eq(chatActions.kind, "confirmation_response"),
            inArray(chatActions.status, ["issued", "processing"]),
            ne(chatActions.id, action.id),
            eq(
              sql<string>`${chatActions.payload}->>'interactionId'`,
              interaction.id,
            ),
          ),
        );
      await notifyChatPublicationWork(tx);
      await tx
        .insert(chatPublications)
        .values({
          companyId: issue.companyId,
          endpointId: action.endpointId,
          conversationId: conversation.id,
          issueId: issue.id,
          idempotencyKey: `interaction-resolution:${interaction.id}:${action.endpointId}`,
          payload: projectSafeChatPublication({
            classification: "external",
            source: "issue_interaction",
            text: `${resolutionLabel}: ${interaction.payload.prompt}`,
            interaction: {
              id: interaction.id,
              card: {
                kind: "confirmation",
                title: interaction.payload.prompt,
                body: resolutionLabel,
                actions: [],
              },
            },
          }),
          state: "pending",
        })
        .onConflictDoNothing();
      if (shouldWake && issue.assigneeAgentId) {
        await tx
          .insert(chatActions)
          .values({
            companyId: issue.companyId,
            endpointId: action.endpointId,
            conversationId: conversation.id,
            principalId: action.principalId,
            kind: "interaction_wakeup",
            providerActionId: `interaction_wakeup:${interaction.id}`,
            payload: {
              version: 1,
              interactionId: interaction.id,
              interactionKind: interaction.kind,
              interactionStatus: interaction.status,
              issueId: issue.id,
              agentId: issue.assigneeAgentId,
              sourceCommentId: interaction.sourceCommentId ?? null,
              sourceRunId: interaction.sourceRunId ?? null,
              requestedByUserId: resolvedByUserId,
              requestedByActorType: "user",
              requestedByActorId: resolvedByUserId,
            },
            status: "issued",
          })
          .onConflictDoNothing();
      }
      // A provider callback can lose the pending -> terminal interaction race
      // to the Paperclip UI. In that case this transaction only retires the
      // now-redundant provider action and must not fabricate a second external
      // resolution event attributed to the board winner.
      if (resolvedByThisProviderAction) {
        await logActivity(tx as unknown as Db, {
          companyId: issue.companyId,
          actorType: "user",
          actorId: resolvedByUserId,
          action:
            interaction.status === "accepted"
              ? "issue.thread_interaction_accepted"
              : "issue.thread_interaction_rejected",
          entityType: "issue",
          entityId: issue.id,
          details: {
            source: "external_chat",
            endpointId: action.endpointId,
            provider: endpoint.provider,
            conversationId: conversation.id,
            publicationId: publication.id,
            providerMessageId: publication.providerMessageId,
            interactionId: interaction.id,
            interactionKind: interaction.kind,
            interactionStatus: interaction.status,
            resolutionActorKind: "user",
            requestedResolverPolicy: interaction.requestedResolverPolicy,
            effectiveResolverPolicy: interaction.effectiveResolverPolicy,
          },
        });
      }
      return true;
    });
  }

  async function reconcileTerminalConfirmationActions(
    limit = 100,
  ): Promise<number> {
    const candidates = await db
      .select({ id: chatActions.id })
      .from(chatActions)
      .where(
        and(
          eq(chatActions.kind, "confirmation_response"),
          eq(chatActions.status, "processing"),
        ),
      )
      .orderBy(asc(chatActions.updatedAt), asc(chatActions.id))
      .limit(limit);
    let settled = 0;
    for (const candidate of candidates) {
      if (await settleTerminalConfirmationAction(candidate.id)) settled += 1;
    }
    return settled;
  }
  return { settleTerminalConfirmationAction, reconcileTerminalConfirmationActions, handleTelegramConfirmation };
}
