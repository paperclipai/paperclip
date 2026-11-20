import { EXTERNAL_CHAT_MESSAGE_WAKE_MUTATION, EXTERNAL_CHAT_MESSAGE_WAKE_REASON } from "../../queued-comment-delivery.js";
import { notifyChatInboundWakeNotices } from "../../chat-inbound-wake-notice-notifications.js";
import { DELIVERY_PROCESSING_STALE_MS } from "./delivery-ledger.js";
import type { EndpointRow, DbOrTransaction } from "../runtime-types.js";
import { notifyChatRunMilestones } from "../../chat-run-milestone-notifications.js";
import { notifyChatDeliveryWork } from "../../chat-work-notifications.js";
import { enqueueFastResponse } from "../../fast-responses.js";
import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { retryChatControlAdmission } from "../../chat-control-admission-retry.js";
import type { Db } from "@paperclipai/db";
import { createDurableChatWakeupRequest, assertDurableChatWakeupReceipt, registerDeferredChatWakeOwner, CLOSED_TASK_CHAT_WAKE_REOPEN_WINDOW_MS, type DeferredChatWakeDecline } from "../../durable-chat-wakeup.js";
import { agentWakeupRequests, chatActions, chatConversations, chatDeliveries, chatEndpoints, heartbeatRuns, issues } from "@paperclipai/db";
import { issueService } from "../../issues.js";
import { forbidden } from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";
import { queueIssueAssignmentWakeup } from "../../issue-assignment-wakeup.js";
import { isGitHubAutomaticDelivery, acknowledgeGitHubWakeup } from "../github/wake-authority.js";
import { githubInboundWakeAdmission, recoverGitHubSteeredWake, steerGitHubInboundWake } from "../github/inbound-steering.js";
import { inboundWakeScope, type createInboundWakeAuthority } from "./wakeup-authorization.js";
import type { createInboundAttachments } from "../inbound-attachments.js";
import type { IssueAssignmentWakeupDeps } from "../../issue-assignment-wakeup.js";
type InboundAttachmentResult = Awaited<ReturnType<ReturnType<typeof createInboundAttachments>["ingestAttachments"]>>;
type WakeupOptions = Pick<ReturnType<typeof createInboundWakeAuthority>, "authorizeInboundWakeup" | "authorizeInboundWorkStart"> & {
  attachmentOmissionDetail: ReturnType<typeof createInboundAttachments>["attachmentOmissionDetail"];
  isExternalActionAuthorizationChange: (error: unknown) => boolean;
  redactError: (error: unknown) => string;
  fetchImpl: typeof globalThis.fetch;
  readonly heartbeat: IssueAssignmentWakeupDeps;
};
export function createInboundWakeups(db: Db, options: WakeupOptions) {
  const { authorizeInboundWakeup, authorizeInboundWorkStart, attachmentOmissionDetail, isExternalActionAuthorizationChange, redactError, fetchImpl } = options;
  async function stageInboundWakeup(
    tx: DbOrTransaction,
    input: {
      endpoint: EndpointRow;
      deliveryId: string;
      conversation: typeof chatConversations.$inferSelect;
      commentId: string;
      principalId: string;
      actorUserId: string | null;
    },
  ) {
    await tx
      .insert(chatActions)
      .values({
        companyId: input.endpoint.companyId,
        endpointId: input.endpoint.id,
        deliveryId: input.deliveryId,
        conversationId: input.conversation.id,
        principalId: input.principalId,
        kind: "inbound_wakeup",
        providerActionId: `inbound_wakeup:${input.deliveryId}`,
        status: "preparing",
        payload: {
          version: 1,
          issueId: input.conversation.issueId,
          agentId: input.endpoint.assignedAgentId,
          commentId: input.commentId,
          sessionGeneration: input.conversation.sessionGeneration,
          requestedByActorType: input.actorUserId ? "user" : "system",
          requestedByActorId: input.actorUserId ?? input.principalId,
        },
      })
      .onConflictDoNothing();
  }

  async function acceptInboundWakeup(
    deliveryId: string,
    attachmentResult: InboundAttachmentResult,
  ) {
    // Retry the rolled-back authorization/admission transaction only. A
    // concurrent ingress may briefly own the endpoint lock; provider I/O
    // and task creation have already completed and must not be repeated.
    await retryChatControlAdmission(() =>
      db.transaction(async (tx) => {
        const action = await tx
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.deliveryId, deliveryId),
              eq(chatActions.kind, "inbound_wakeup"),
            ),
          )
          .limit(1)
          .then((rows) => rows[0] ?? null);
        if (!action) throw new Error("chat_inbound_wakeup_intent_missing");
        const { delivery } = await authorizeInboundWakeup(tx, action);
        if (delivery.state === "processed") return;
        if (delivery.state !== "processing")
          throw new Error("chat_inbound_wakeup_delivery_claim_lost");
        if (action.status !== "preparing") {
          const existingReceipt = await tx
            .select()
            .from(agentWakeupRequests)
            .where(eq(agentWakeupRequests.id, action.id))
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!existingReceipt)
            throw new Error("chat_inbound_wakeup_action_claim_lost");
          assertDurableChatWakeupReceipt(
            createDurableChatWakeupRequest({
              id: action.id,
              companyId: action.companyId,
              agentId: String(action.payload.agentId),
              issueId: String(action.payload.issueId),
              commentId: String(action.payload.commentId),
              requestedByActorType: action.payload.requestedByActorType as
                "user" | "system",
              requestedByActorId: String(action.payload.requestedByActorId),
              requestedAt: action.createdAt,
              authorize: async () => { },
            }),
            existingReceipt,
          );
        }
        await notifyChatDeliveryWork(tx);
        if (action.status === "processed") {
          await notifyChatRunMilestones(tx, { companyId: action.companyId, issueId: String(action.payload.issueId) });
        } else if (action.status === "failed") {
          await notifyChatInboundWakeNotices(tx, { companyId: action.companyId, issueId: String(action.payload.issueId) });
        }
        const acceptedAt = new Date();
        const accepted = await tx
          .update(chatDeliveries)
          .set({
            state: "processed",
            processedAt: acceptedAt,
            redactedError: sql<string | null>`nullif(concat_ws(${"\n"}, (
              select replace(replace(${chatActions.result}->>'redactedError', ${"\n"}, ' '), ${"\r"}, ' ') from ${chatActions}
              where ${chatActions.companyId} = ${delivery.companyId}
                and ${chatActions.endpointId} = ${delivery.endpointId}
                and ${chatActions.deliveryId} = ${deliveryId}
                and ${chatActions.providerActionId} = ${`receipt_reaction:${deliveryId}`}
                and ${chatActions.kind} = 'receipt_reaction'
                and ${chatActions.status} = 'failed'
                and ${chatActions.payload}->>'operation' = 'add'
              limit 1
            ), ${attachmentOmissionDetail(attachmentResult)}::text), '')`,
            nextAttemptAt: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatDeliveries.id, deliveryId),
              eq(chatDeliveries.state, "processing"),
              eq(chatDeliveries.updatedAt, delivery.updatedAt),
            ),
          )
          .returning({ id: chatDeliveries.id });
        if (accepted.length !== 1)
          throw new Error("chat_inbound_wakeup_delivery_claim_lost");
        // An operator can repair a failed delivery ledger after its wake was
        // already committed. Keep the immutable receipt and never admit twice.
        if (action.status !== "preparing") return;
        await notifyChatDeliveryWork(tx);
        const issued = await tx
          .update(chatActions)
          .set({
            status: "issued",
            payload: {
              ...action.payload,
              attachmentOmissionReasons: attachmentResult.omissionReasons,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "preparing"),
            ),
          )
          .returning({ id: chatActions.id });
        if (issued.length !== 1)
          throw new Error("chat_inbound_wakeup_action_claim_lost");
        const source = delivery.normalizedEvent as { principal?: { isBot?: boolean }; message?: { text?: string } };
        if (!isGitHubAutomaticDelivery(delivery) && !source.principal?.isBot && !/^\s*\//.test(source.message?.text ?? "")) {
          await enqueueFastResponse(tx as unknown as Db, {
            companyId: action.companyId, issueId: String(action.payload.issueId), agentId: String(action.payload.agentId),
            sourceCommentId: String(action.payload.commentId), sourceKey: `comment:${action.payload.commentId}`, acceptedAt,
            responsibleUserId: action.payload.requestedByActorType === "user" ? String(action.payload.requestedByActorId) : null,
            sponsored: action.payload.requestedByActorType !== "user", endpointId: action.endpointId, conversationId: action.conversationId, deliveryId: action.deliveryId
          });
        }
      }),
    );
  }

  async function settleRejectedInboundWakeups(onlyDeliveryId?: string) {
    await db
      .update(chatActions)
      .set({
        status: "failed",
        result: { code: "inbound_wakeup_delivery_rejected" },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(chatActions.kind, "inbound_wakeup"),
          eq(chatActions.status, "preparing"),
          onlyDeliveryId
            ? eq(chatActions.deliveryId, onlyDeliveryId)
            : undefined,
          sql`exists (select 1 from ${chatDeliveries}
            where ${chatDeliveries.id} = ${chatActions.deliveryId}
              and ${chatDeliveries.companyId} = ${chatActions.companyId}
              and ${chatDeliveries.endpointId} = ${chatActions.endpointId}
              and ${chatDeliveries.state} in ('filtered', 'failed'))`,
        ),
      );
  }

  async function processInboundWakeup(deliveryId: string): Promise<boolean> {
    const now = new Date();
    const candidate = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.deliveryId, deliveryId),
          eq(chatActions.kind, "inbound_wakeup"),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (
      !candidate ||
      !["preparing", "issued", "processing"].includes(candidate.status)
    )
      return true;
    if (
      candidate.status === "preparing" ||
      (candidate.status === "processing" &&
        candidate.updatedAt.getTime() >
        now.getTime() - DELIVERY_PROCESSING_STALE_MS) ||
      (typeof candidate.result?.retryAt === "string" &&
        Date.parse(candidate.result.retryAt) > now.getTime())
    )
      return false;
    const claimed = await db.transaction(async (tx) => {
      await notifyChatDeliveryWork(tx);
      return tx
        .update(chatActions)
        .set({ status: "processing", updatedAt: now })
        .where(
          and(
            eq(chatActions.id, candidate.id),
            eq(chatActions.status, candidate.status),
            eq(chatActions.updatedAt, candidate.updatedAt),
          ),
        )
        .returning()
        .then((rows) => rows[0] ?? null);
    });
    if (!claimed) return false;
    const attemptCount = Number(candidate.result?.attemptCount ?? 0) + 1;
    const receiptDeclined = (row: typeof agentWakeupRequests.$inferSelect) =>
      ["skipped", "cancelled", "failed"].includes(row.status);
    const settle = async (status: string, result: Record<string, unknown>) => {
      const changed = await db.transaction(async (tx) => {
        await notifyChatDeliveryWork(tx);
        if (status === "processed") {
          await notifyChatRunMilestones(tx, { companyId: claimed.companyId, issueId: request!.issueId });
        } else if (status === "failed" && request) {
          await notifyChatInboundWakeNotices(tx, { companyId: claimed.companyId, issueId: request.issueId });
        }
        const changed = await tx
          .update(chatActions)
          .set({ status, result, updatedAt: new Date() })
          .where(
            and(
              eq(chatActions.id, claimed.id),
              eq(chatActions.status, "processing"),
              eq(chatActions.updatedAt, now),
            ),
          )
          .returning({ id: chatActions.id });
        if (changed.length && status === "failed") {
          await tx
            .update(chatDeliveries)
            .set({
              redactedError:
                result.code === "inbound_wakeup_authorization_changed"
                  ? "Input saved. Work was not scheduled because current chat access no longer permits it."
                  : "Input saved. Its work request was skipped, cancelled, or failed; no automatic replay was performed.",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatDeliveries.id, deliveryId),
                eq(chatDeliveries.companyId, claimed.companyId),
                eq(chatDeliveries.state, "processed"),
              ),
            );
        }
        return changed.length > 0;
      });
      // A durable scheduler receipt must accept the work before GitHub shows
      // it as working. This also covers acceptance after a maintenance retry.
      if (changed && status === "processed") {
        const [endpoint] = await db.select({ provider: chatEndpoints.provider })
          .from(chatEndpoints).where(and(eq(chatEndpoints.id, claimed.endpointId),
            eq(chatEndpoints.companyId, claimed.companyId)));
        if (endpoint?.provider === "github")
          await acknowledgeGitHubWakeup(db, fetchImpl, deliveryId);
      }
    };
    let request: ReturnType<typeof createDurableChatWakeupRequest> | null =
      null;
    let githubAdmission: Awaited<ReturnType<typeof githubInboundWakeAdmission>> | undefined;
    const receipt = async () => {
      const row = await db
        .select()
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, claimed.id))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (row && request) assertDurableChatWakeupReceipt(request, row);
      return row;
    };
    try {
      if (
        claimed.payload.version !== 1 ||
        typeof claimed.payload.agentId !== "string" ||
        typeof claimed.payload.issueId !== "string" ||
        typeof claimed.payload.commentId !== "string" ||
        typeof claimed.payload.requestedByActorId !== "string" ||
        !["user", "system"].includes(
          String(claimed.payload.requestedByActorType),
        )
      ) {
        throw forbidden("Invalid durable inbound chat source", {
          code: "chat_action_authorization_changed",
        });
      }
      request = createDurableChatWakeupRequest({
        id: claimed.id,
        companyId: claimed.companyId,
        agentId: claimed.payload.agentId,
        issueId: claimed.payload.issueId,
        commentId: claimed.payload.commentId,
        requestedByActorType: claimed.payload.requestedByActorType as
          | "user"
          | "system",
        requestedByActorId: String(claimed.payload.requestedByActorId),
        requestedAt: claimed.createdAt,
        authorize: async (tx) => {
          const current = await authorizeInboundWorkStart(tx, claimed);
          await githubAdmission?.authorize(tx, current.issue);
          if (current.delivery.state !== "processed")
            throw new Error("chat_inbound_wakeup_acceptance_not_committed");
        },
      });
      let priorReceipt = await receipt();
      if (priorReceipt) {
        if (priorReceipt.status === "deferred_issue_execution") {
          await steerGitHubInboundWake(db, claimed, request, authorizeInboundWorkStart);
          priorReceipt = (await receipt())!;
        }
        await settle(receiptDeclined(priorReceipt) ? "failed" : "processed", {
          code: receiptDeclined(priorReceipt)
            ? `inbound_wakeup_${priorReceipt.status}`
            : "inbound_wakeup_already_durable",
          wakeupRequestId: priorReceipt.id,
          runId: priorReceipt.runId,
          receiptStatus: priorReceipt.status,
          attemptCount,
        });
        return true;
      }
      const context = await db.transaction((tx) =>
        authorizeInboundWorkStart(tx, claimed),
      );
      if (context.delivery.state !== "processed")
        throw new Error("chat_inbound_wakeup_acceptance_not_committed");
      if (context.endpoint.provider === "github") githubAdmission = await githubInboundWakeAdmission(db, context.issue);
      await queueIssueAssignmentWakeup({
        heartbeat: options.heartbeat,
        issue: context.issue,
        reason: EXTERNAL_CHAT_MESSAGE_WAKE_REASON,
        mutation: EXTERNAL_CHAT_MESSAGE_WAKE_MUTATION,
        contextSource: `chat:${context.endpoint.provider}`,
        requestedByActorType: request.requestedByActorType,
        requestedByActorId: request.requestedByActorId,
        taskKey: context.issue.identifier,
        wakeCommentId: request.commentId,
        chatConversationId: context.conversation.id,
        ...githubAdmission?.options,
        attachmentOmissionReasons: claimed.payload.attachmentOmissionReasons as
          | Record<string, number>
          | undefined,
        durableChatRequest: request,
        rethrowOnError: true,
      });
      if (context.endpoint.provider === "github")
        await steerGitHubInboundWake(db, claimed, request, authorizeInboundWorkStart);
      const durable = await receipt();
      if (!durable) throw new Error("chat_inbound_wakeup_receipt_missing");
      await settle(receiptDeclined(durable) ? "failed" : "processed", {
        code: receiptDeclined(durable)
          ? `inbound_wakeup_${durable.status}`
          : "inbound_wakeup_durable",
        wakeupRequestId: durable.id,
        runId: durable.runId,
        receiptStatus: durable.status,
        ...(durable.status === "skipped" ? { reason: durable.reason } : {}),
        attemptCount,
      });
      return true;
    } catch (error) {
      const conflictingReceipt =
        error instanceof Error &&
        error.message === "chat_inbound_wakeup_receipt_conflict";
      const durable = request && !conflictingReceipt ? await receipt() : null;
      if (durable) {
        await settle(receiptDeclined(durable) ? "failed" : "processed", {
          code: receiptDeclined(durable)
            ? `inbound_wakeup_${durable.status}`
            : "inbound_wakeup_already_durable",
          wakeupRequestId: durable.id,
          runId: durable.runId,
          receiptStatus: durable.status,
          attemptCount,
        });
        return true;
      }
      const denied =
        conflictingReceipt || isExternalActionAuthorizationChange(error);
      await settle(denied ? "failed" : "issued", {
        code: conflictingReceipt
          ? "inbound_wakeup_receipt_conflict"
          : denied
            ? "inbound_wakeup_authorization_changed"
            : "inbound_wakeup_retry",
        attemptCount,
        ...(!denied
          ? {
            retryAt: new Date(
              Date.now() +
              Math.min(30_000, 1000 * 2 ** Math.min(attemptCount, 5)),
            ).toISOString(),
          }
          : {}),
      });
      if (!denied)
        logger.warn(
          { deliveryId, error: redactError(error) },
          "accepted inbound chat wakeup will retry",
        );
      return denied;
    }
  }
  async function reopenClosedChatTask(tx: Db, action: typeof chatActions.$inferSelect) {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, action.companyId),
      eq(issues.id, String(action.payload.issueId)))).for("update");
    if (!issue || issue.assigneeAgentId !== action.payload.agentId || !["done", "cancelled"].includes(issue.status)) return;
    const [endpoint] = await tx.select({ sponsorUserId: chatEndpoints.sponsorUserId }).from(chatEndpoints)
      .where(and(eq(chatEndpoints.companyId, action.companyId), eq(chatEndpoints.id, action.endpointId)));
    await issueService(tx).update(issue.id, { status: "todo",
      actorUserId: action.payload.requestedByActorType === "user" ? String(action.payload.requestedByActorId) : endpoint?.sponsorUserId ?? null,
    }, tx);
  }
  async function recentClosedTaskChatWakes(scope: { companyId: string; agentId: string; issueId: string },
    action: typeof chatActions.$inferSelect) {
    const rows = await db.select({ receipt: agentWakeupRequests, action: chatActions }).from(agentWakeupRequests)
      .innerJoin(chatActions, and(eq(chatActions.companyId, agentWakeupRequests.companyId), eq(chatActions.id, agentWakeupRequests.id)))
      .where(and(eq(agentWakeupRequests.companyId, scope.companyId), eq(agentWakeupRequests.agentId, scope.agentId),
        eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId),
        sql`${agentWakeupRequests.idempotencyKey} like 'chat-inbound:%'`,
        sql`${agentWakeupRequests.payload}->>'issueId' = ${scope.issueId}`,
        gte(agentWakeupRequests.createdAt, new Date(Date.now() - CLOSED_TASK_CHAT_WAKE_REOPEN_WINDOW_MS)),
        eq(chatActions.kind, "inbound_wakeup"), eq(chatActions.status, "processed"),
        action.conversationId ? eq(chatActions.conversationId, action.conversationId) : isNull(chatActions.conversationId),
        sql`${chatActions.payload}->>'issueId' = ${scope.issueId}`, sql`${chatActions.payload}->>'agentId' = ${scope.agentId}`))
      .orderBy(asc(agentWakeupRequests.createdAt), asc(agentWakeupRequests.id));
    return rows;
  }
  const unregisterDeferredWakeOwner = registerDeferredChatWakeOwner(db, async (scope): Promise<DeferredChatWakeDecline | void> => {
    const saved = await db.select().from(chatActions).where(and(
      eq(chatActions.id, scope.requestId), eq(chatActions.companyId, scope.companyId),
    )).then(rows => rows[0] ?? null);
    if (!saved || saved.kind !== "inbound_wakeup") return;
    const source = saved;
    const [receipt] = await db.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.id, scope.requestId), eq(agentWakeupRequests.companyId, scope.companyId),
      eq(agentWakeupRequests.agentId, scope.agentId), eq(agentWakeupRequests.status, "deferred_issue_execution"),
    ));
    if (!receipt || receipt.runId) return;
    const sweep = scope.recoverySweep === true;
    if (["preparing", "issued", "processing"].includes(source.status)) return sweep ? { retry: "source_pending" } : undefined;
    if (source.status !== "processed" || source.payload.agentId !== scope.agentId ||
        source.payload.issueId !== scope.issueId) return sweep ? { settle: "source_missing" } : undefined;
    if (await recoverGitHubSteeredWake(db, source)) return;
    let closed = false;
    if (sweep) {
      const [task] = await db.select({ status: issues.status, assigneeAgentId: issues.assigneeAgentId }).from(issues)
        .where(and(eq(issues.companyId, scope.companyId), eq(issues.id, scope.issueId)));
      if (!task) return { settle: "task_missing" };
      if (task.assigneeAgentId !== scope.agentId) return { settle: "task_reassigned" };
      if (task.status === "backlog") return { retry: "task_backlog" };
      closed = task.status === "done" || task.status === "cancelled";
      if (closed && receipt.createdAt.getTime() < Date.now() - CLOSED_TASK_CHAT_WAKE_REOPEN_WINDOW_MS) return { settle: "task_closed" };
    }
    const candidates: Awaited<ReturnType<typeof recentClosedTaskChatWakes>> = [];
    if (closed) {
      for (const candidate of await recentClosedTaskChatWakes(scope, source)) {
        if (candidate.receipt.id !== receipt.id && !(await recoverGitHubSteeredWake(db, candidate.action))) candidates.push(candidate);
      }
    }
    const authorizeAction = async (tx: Db, saved: typeof chatActions.$inferSelect) => {
      const [current] = await tx.select().from(chatActions).where(and(
        eq(chatActions.id, saved.id), eq(chatActions.companyId, scope.companyId),
        eq(chatActions.kind, "inbound_wakeup"), eq(chatActions.status, "processed"),
      ));
      if (!current || inboundWakeScope(current) !== inboundWakeScope(saved))
        throw forbidden("The saved chat source changed", { code: "chat_action_authorization_changed" });
      const authorized = await authorizeInboundWorkStart(tx, current);
      if (authorized.delivery.state !== "processed") throw new Error("chat_inbound_wakeup_acceptance_not_committed");
      return authorized;
    };
    const accepted: typeof candidates = [];
    // The same authority used at ingress checks the live endpoint, principal,
    // immutable action source, conversation generation and original comment.
    const context = await db.transaction(async tx => {
      if (closed) await reopenClosedChatTask(tx as unknown as Db, source);
      const authorized = await authorizeAction(tx as unknown as Db, source);
      for (const candidate of candidates) {
        if (await tx.transaction(inner => authorizeAction(inner as unknown as Db, candidate.action)).then(() => true, () => false))
          accepted.push(candidate);
      }
      return authorized;
    });
    const batch = [{ receipt, action: source }, ...accepted].sort((left, right) =>
      left.receipt.createdAt.getTime() - right.receipt.createdAt.getTime() || left.receipt.id.localeCompare(right.receipt.id));
    const { receipt: primaryReceipt, action } = batch.at(-1)!;
    const riders = batch.slice(0, -1);
    const githubAdmission = context.endpoint.provider === "github" ? await githubInboundWakeAdmission(db, context.issue) : undefined;
    const request = createDurableChatWakeupRequest({
      id: action.id, companyId: scope.companyId, agentId: scope.agentId, issueId: scope.issueId,
      commentId: String(action.payload.commentId),
      requestedByActorType: action.payload.requestedByActorType as "user" | "system",
      requestedByActorId: String(action.payload.requestedByActorId), requestedAt: action.createdAt,
      resumeDeferred: true,
      authorize: async tx => {
        const authorized = await authorizeAction(tx, action);
        await githubAdmission?.authorize(tx, authorized.issue);
        if (!riders.length) return;
        const current = await tx.select({ status: agentWakeupRequests.status, runId: agentWakeupRequests.runId })
          .from(agentWakeupRequests).where(and(eq(agentWakeupRequests.companyId, scope.companyId),
            inArray(agentWakeupRequests.id, riders.map(rider => rider.receipt.id)))).for("update");
        if (current.length !== riders.length || current.some(row => row.status !== "deferred_issue_execution" || row.runId))
          throw new Error("chat_inbound_wakeup_batch_changed");
      },
      ...(riders.length ? { onAdmitted: async (tx: Db, admitted: { runId: string | null }) => {
        if (!admitted.runId) return;
        const now = new Date();
        await tx.update(agentWakeupRequests).set({ status: "coalesced", runId: admitted.runId, finishedAt: now, updatedAt: now,
          payload: sql`coalesce(${agentWakeupRequests.payload}, '{}'::jsonb) || ${JSON.stringify({ coalescedIntoWakeupRequestId: action.id })}::jsonb`,
        }).where(and(eq(agentWakeupRequests.companyId, scope.companyId),
          inArray(agentWakeupRequests.id, riders.map(rider => rider.receipt.id)),
          eq(agentWakeupRequests.status, "deferred_issue_execution"), isNull(agentWakeupRequests.runId)));
      } } : {}),
    });
    assertDurableChatWakeupReceipt(request, primaryReceipt);
    await queueIssueAssignmentWakeup({ heartbeat: options.heartbeat, issue: context.issue,
      reason: EXTERNAL_CHAT_MESSAGE_WAKE_REASON, mutation: EXTERNAL_CHAT_MESSAGE_WAKE_MUTATION,
      contextSource: `chat:${context.endpoint.provider}`, taskKey: context.issue.identifier,
      requestedByActorType: request.requestedByActorType, requestedByActorId: request.requestedByActorId,
      wakeCommentId: request.commentId, chatConversationId: context.conversation.id,
      ...githubAdmission?.options,
      ...(riders.length ? { wakeCommentIds: batch.map(entry => String(entry.action.payload.commentId)) } : {}),
      attachmentOmissionReasons: action.payload.attachmentOmissionReasons as Record<string, number> | undefined,
      durableChatRequest: request, rethrowOnError: true });
  });
  return { stageInboundWakeup, acceptInboundWakeup, settleRejectedInboundWakeups, processInboundWakeup, unregisterDeferredWakeOwner };
}
