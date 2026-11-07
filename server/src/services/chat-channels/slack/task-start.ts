import type { EndpointRow, DbTransaction, DbOrTransaction, RuntimeContext, LifecycleRuntimeFence, InboundRuntimeContext } from "../runtime-types.js";

import { dueChatAction, SLACK_COMMAND_POST_STALE_MS, SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS, SLACK_COMMAND_ADMISSION_STALE_MS } from "../../chat-action-work.js";

import { notifyChatActionWork } from "../../chat-work-notifications.js";

import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import { chatCredentialMutationLease, type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import {
  randomUUID,
} from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatActions,
  chatConversations,
  chatEndpointResources,
  chatEndpoints,
  chatExternalPrincipals,
  chatIdentityLinks,
  companyMemberships,
  issues,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import { logger } from "../../../middleware/logger.js";
import { redactSensitiveText } from "../../../redaction.js";

import {
  type ChatSdkMessageCallbackEvent,
} from "../../chat-sdk-runtime.js";

import { classifyChatPublicationError } from "../../chat-publication-errors.js";

import type {
  Author,
  Message,
  Thread,
} from "chat";

import type { EndpointRecord } from "../runtime-types.js";

export type SlackSlashTaskRecoveryPayload = {
  channelId: string;
  command: string;
  syntheticMessageId: string;
  taskText: string;
};

export function slackSlashTaskRecoveryPayload(
  payload: Record<string, unknown>,
): SlackSlashTaskRecoveryPayload | null {
  const channelId = payload.channelId;
  const command = payload.command;
  const syntheticMessageId = payload.syntheticMessageId;
  const taskText = payload.taskText;
  if (
    typeof channelId !== "string" ||
    !channelId.trim() ||
    typeof command !== "string" ||
    !command.trim() ||
    typeof syntheticMessageId !== "string" ||
    !syntheticMessageId.trim() ||
    typeof taskText !== "string" ||
    !taskText.trim()
  ) {
    return null;
  }
  return { channelId, command, syntheticMessageId, taskText };
}

export function slackTaskStarterThreadId(
  channelId: string,
  providerMessageId: string,
): string {
  return `slack:${channelId.replace(/^slack:/, "")}:${providerMessageId}`;
}

export function confirmedSlackTaskStartResult(
  result: Record<string, unknown> | null,
): {
  authorizedUserId?: string | null;
  providerMessageId: string;
  threadId: string;
} | null {
  if (
    !result ||
    typeof result.providerMessageId !== "string" ||
    !result.providerMessageId ||
    typeof result.threadId !== "string" ||
    !result.threadId
  ) {
    return null;
  }
  const hasAuthorizedUserId = Object.prototype.hasOwnProperty.call(
    result,
    "authorizedUserId",
  );
  if (
    hasAuthorizedUserId &&
    result.authorizedUserId !== null &&
    (typeof result.authorizedUserId !== "string" || !result.authorizedUserId)
  ) {
    return null;
  }
  return {
    ...(hasAuthorizedUserId
      ? { authorizedUserId: result.authorizedUserId as string | null }
      : {}),
    providerMessageId: result.providerMessageId,
    threadId: result.threadId,
  };
}
type ResourceRow = typeof chatEndpointResources.$inferSelect;
type SlackTaskStartOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  invalidateRuntime: (endpointId: string) => Promise<boolean>;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  processMessage: (endpoint: EndpointRow, thread: Thread, message: Message, trigger: ChatSdkMessageCallbackEvent["trigger"], ingressOnly?: boolean, recoveredProviderUrl?: string | null, runtimeContext?: InboundRuntimeContext, providerUpdateId?: number, admittedDeliveryId?: string | null, receiptReactionSupported?: boolean, preauthorizedUserId?: string | null, deferDrainUntilFollowup?: boolean, suppressSetupDestinationActivation?: boolean, slackSlashControl?: boolean) => Promise<void>;
  redactError: (error: unknown) => string;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  sponsorAllowsGuest: (endpoint: EndpointRow) => Promise<boolean>;
  nonDirectDestinationAllowed: (endpoint: EndpointRow, resource: ResourceRow | null | undefined) => boolean;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  lockCurrentPrincipalAuthorization: (tx: DbOrTransaction, endpoint: EndpointRow, principalId: string) => Promise<{ allowed: boolean; userId: string | null }>;
  slackTaskAdmissionClaimBarrier?: (input: { actionId: string; claimId: string }) => Promise<void>;
  maxErrorText: number;
};

export function createSlackTaskStart(db: Db, options: SlackTaskStartOptions) {
  const { endpointRecord, runtimeGeneration, credentialFingerprint, invalidateRuntime, runtimeFor, processMessage, runtimeContextForRecord, redactError, withCredentialMutationLease, sponsorAllowsGuest, nonDirectDestinationAllowed, runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization, maxErrorText: MAX_ERROR_TEXT } = options;


  async function latestSlackDmControlThreadId(
    endpointId: string,
    rawChannelId: string,
  ): Promise<string | null> {
    const conversationIds = [rawChannelId, `slack:${rawChannelId}`];
    return db
      .select({ externalThreadId: chatConversations.externalThreadId })
      .from(chatConversations)
      .innerJoin(
        issues,
        and(
          eq(issues.companyId, chatConversations.companyId),
          eq(issues.id, chatConversations.issueId),
        ),
      )
      .where(
        and(
          eq(chatConversations.endpointId, endpointId),
          inArray(chatConversations.externalConversationId, conversationIds),
          eq(chatConversations.isDirectMessage, true),
          inArray(chatConversations.state, ["active", "waiting"]),
          notInArray(issues.status, ["done", "cancelled"]),
        ),
      )
      .orderBy(
        desc(chatConversations.lastActivityAt),
        desc(chatConversations.createdAt),
      )
      .limit(1)
      .then((rows) => rows[0]?.externalThreadId ?? null);
  }

  async function finalizeSlackTaskStartFailure(input: {
    actionId: string;
    actionStatus: "received" | "validating" | "resolving";
    attempt?: number;
    connectionId: string;
    credentialLease: CredentialMutationLeaseGuard;
    endpoint: EndpointRow;
    error: unknown;
    providerAttempted?: boolean;
    resource: ResourceRow | null;
    runtimeFence: LifecycleRuntimeFence;
  }): Promise<boolean> {
    const attempt = input.attempt ?? 1;
    const classified = classifyChatPublicationError(input.error, attempt);
    // Runtime construction, lease acquisition, and authorization validation
    // happen before the transport fence. Even a socket-shaped error in that
    // phase is known not to have sent a Slack message and remains safely
    // retryable instead of entering the ambiguous-delivery quarantine.
    const classifiedDisposition =
      input.providerAttempted === false &&
      classified.kind === "delivery_unknown"
        ? {
            kind: "retry" as const,
            retryAfterMs: Math.min(60_000, 2 ** Math.max(0, attempt) * 1000),
            reason: classified.reason,
          }
        : classified;
    await input.credentialLease.assertOwned();
    const currentRecord = await endpointRecord(input.endpoint.id);
    const runtimeFenceCurrent =
      currentRecord !== null &&
      runtimeGeneration(currentRecord.endpoint.setup) ===
        input.runtimeFence.generation &&
      credentialFingerprint(currentRecord.credentialSecretRefs) ===
        input.runtimeFence.credentialFingerprint;
    // A provider rejection from credentials that were superseded while this
    // worker lost its lease cannot quarantine the successor endpoint or its
    // resources. Preserve genuinely ambiguous provider acceptance, but make a
    // definite old-runtime rejection safely retryable so the normal worker can
    // re-authorize it against the current endpoint before any new Slack call.
    const disposition =
      !runtimeFenceCurrent && classifiedDisposition.kind !== "delivery_unknown"
        ? {
            kind: "retry" as const,
            retryAfterMs: 1_000,
            reason: "Slack runtime changed before failure settlement",
          }
        : classifiedDisposition;
    const failure = redactSensitiveText(disposition.reason).slice(
      0,
      MAX_ERROR_TEXT,
    );
    const finalized = await db.transaction(async (tx) => {
      await input.credentialLease.assertOwned(tx);
      await notifyChatActionWork(tx, "slash_task_start");
      const [ownedAction] = await tx
        .update(chatActions)
        .set({
          status:
            disposition.kind === "delivery_unknown"
              ? "delivery_unknown"
              : disposition.kind === "retry"
                ? "queued"
                : "failed",
          result: {
            code: runtimeFenceCurrent
              ? `slash_task_${disposition.kind}`
              : disposition.kind === "delivery_unknown"
                ? "slash_task_delivery_unknown"
                : "slash_task_runtime_superseded",
            redactedError: failure,
            retryable: disposition.kind === "retry",
            attemptCount: attempt,
            ...(disposition.kind === "retry"
              ? {
                  retryAt: new Date(
                    Date.now() + disposition.retryAfterMs,
                  ).toISOString(),
                }
              : {}),
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, input.actionId),
            eq(chatActions.status, input.actionStatus),
            sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
          ),
        )
        .returning({ id: chatActions.id });
      if (!ownedAction) return false;
      if (runtimeFenceCurrent && disposition.kind === "endpoint_attention") {
        await tx
          .update(chatEndpoints)
          .set({
            status: "attention",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            updatedAt: new Date(),
          })
          .where(eq(chatEndpoints.id, input.endpoint.id));
        await tx
          .update(toolConnections)
          .set({
            status: "disabled",
            enabled: false,
            healthStatus: "degraded",
            healthMessage: "Provider credentials or permissions need attention",
            lastError: failure,
            healthCheckedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(toolConnections.id, input.connectionId));
      } else if (
        runtimeFenceCurrent &&
        disposition.kind === "resource_unavailable" &&
        input.resource
      ) {
        await tx
          .update(chatEndpointResources)
          .set({ availability: "unavailable", updatedAt: new Date() })
          .where(eq(chatEndpointResources.id, input.resource.id));
      }
      await input.credentialLease.assertOwned(tx);
      return true;
    });
    if (
      finalized &&
      runtimeFenceCurrent &&
      disposition.kind === "endpoint_attention"
    ) {
      // Runtime removal mutates process-local provider state after the durable
      // transaction. Prove this worker still owns the credential fence at the
      // last await boundary so a reclaimer cannot have installed a successor
      // runtime that this obsolete failure would then remove.
      await input.credentialLease.assertOwned();
      await invalidateRuntime(input.endpoint.id).catch(() => undefined);
    }
    return finalized;
  }

  async function admitConfirmedSlackTaskStart(
    actionId: string,
    ingressOnly = true,
  ): Promise<boolean> {
    const admissionClaimId = randomUUID();
    const staleAdmission = new Date(
      Date.now() - SLACK_COMMAND_ADMISSION_STALE_MS,
    );
    const [action] = await db.transaction(async (tx) => {
      await notifyChatActionWork(tx, "slash_task_start");
      return tx
        .update(chatActions)
        .set({
          status: "admitting",
          result: sql`coalesce(${chatActions.result}, '{}'::jsonb)
            || jsonb_build_object('admissionClaimId', ${admissionClaimId}::text)`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, actionId),
            eq(chatActions.kind, "slash_task_start"),
            or(
              eq(chatActions.status, "provider_confirmed"),
              and(
                eq(chatActions.status, "admitting"),
                lte(chatActions.updatedAt, staleAdmission),
              ),
            ),
          ),
        )
        .returning();
    });
    if (!action) return false;
    await options.slackTaskAdmissionClaimBarrier?.({
      actionId: action.id,
      claimId: admissionClaimId,
    });

    const recovery = slackSlashTaskRecoveryPayload(action.payload);
    const confirmed = confirmedSlackTaskStartResult(action.result);
    const ownsAdmission = () =>
      and(
        eq(chatActions.id, action.id),
        eq(chatActions.status, "admitting"),
        sql`${chatActions.result}->>'admissionClaimId' = ${admissionClaimId}`,
      );
    const failAdmission = async (code: string, detail: string) => {
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "slash_task_start");
        return tx
          .update(chatActions)
          .set({
            status: "failed",
            result: {
              ...(confirmed ?? {}),
              code,
              redactedError: redactSensitiveText(detail).slice(0, MAX_ERROR_TEXT),
            },
            updatedAt: new Date(),
          })
          .where(ownsAdmission());
      });
    };
    if (!recovery || !confirmed || !action.principalId) {
      await failAdmission(
        "slash_task_admission_context_missing",
        "Confirmed Slack task start lacks durable admission context",
      );
      return true;
    }

    const record = await endpointRecord(action.endpointId);
    if (!record || record.endpoint.provider !== "slack") {
      await failAdmission(
        "slash_task_endpoint_missing",
        "Slack endpoint is no longer available",
      );
      return true;
    }
    if (!["verifying", "active"].includes(record.endpoint.status)) {
      if (record.endpoint.status === "archived") {
        await failAdmission(
          "slash_task_endpoint_archived",
          "Slack endpoint was archived before task admission completed",
        );
      } else {
        // The provider-visible send is already confirmed. Wait for an
        // operator to repair/resume the endpoint, then continue Paperclip-only
        // admission without sending another Slack message.
        await db.transaction(async (tx) => {
          await notifyChatActionWork(tx, "slash_task_start");
          return tx
            .update(chatActions)
            .set({
              status: "provider_confirmed",
              result: confirmed,
              updatedAt: new Date(),
            })
            .where(ownsAdmission());
        });
      }
      return true;
    }
    const principal = await db
      .select()
      .from(chatExternalPrincipals)
      .where(
        and(
          eq(chatExternalPrincipals.id, action.principalId),
          eq(chatExternalPrincipals.companyId, record.endpoint.companyId),
          eq(chatExternalPrincipals.provider, "slack"),
          eq(
            chatExternalPrincipals.providerAccountId,
            record.endpoint.providerAccountId ?? "unknown",
          ),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!principal || principal.isBot || principal.kind !== "user") {
      await failAdmission(
        "slash_task_principal_missing",
        "Original Slack account is no longer available",
      );
      return true;
    }

    const author = {
      userId: principal.externalId,
      userName: principal.handle ?? principal.externalId,
      fullName:
        principal.displayName ?? principal.handle ?? principal.externalId,
      isBot: false,
      isMe: false,
      isSystem: false,
    } satisfies Author;
    try {
      const endpointRuntime = await runtimeFor(record.endpoint);
      const thread = endpointRuntime.thread(confirmed.threadId);
      await processMessage(
        record.endpoint,
        thread,
        {
          id: recovery.syntheticMessageId,
          threadId: thread.id,
          text: recovery.taskText,
          formatted: { type: "root", children: [] },
          raw: { recoveredFromActionId: action.id },
          author,
          metadata: { dateSent: action.createdAt, edited: false },
          attachments: [],
          links: [],
          isMention: true,
        } as unknown as Message,
        "mention",
        ingressOnly,
        null,
        { ...runtimeContextForRecord(record), endpointRuntime },
        undefined,
        null,
        false,
        undefined,
        false,
        true,
      );
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "slash_task_start");
        return tx
          .update(chatActions)
          .set({ status: "processed", result: confirmed, updatedAt: new Date() })
          .where(ownsAdmission());
      });
      return true;
    } catch (error) {
      // The provider post is already confirmed, so this retry is strictly a
      // Paperclip admission retry. Preserve the root tuple and let the durable
      // reconciler resume without ever posting to Slack again.
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "slash_task_start");
        return tx
          .update(chatActions)
          .set({
            status: "provider_confirmed",
            result: {
              ...confirmed,
              code: "slash_task_admission_retry",
              retryAt: new Date(Date.now() + 1_000).toISOString(),
              redactedError: redactError(error),
            },
            updatedAt: new Date(),
          })
          .where(ownsAdmission());
      });
      throw error;
    }
  }

  async function processSlackTaskStart(
    actionId: string,
    ingressOnly = true,
  ): Promise<boolean> {
    let action = await db
      .select()
      .from(chatActions)
      .where(
        and(
          eq(chatActions.id, actionId),
          eq(chatActions.kind, "slash_task_start"),
        ),
      )
      .then((rows) => rows[0] ?? null);
    if (!action) return false;

    if (
      action.status === "provider_confirmed" ||
      action.status === "admitting"
    ) {
      return await admitConfirmedSlackTaskStart(action.id, ingressOnly);
    }
    if (action.status === "resolving") {
      if (
        action.updatedAt.getTime() <=
        Date.now() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS
      ) {
        const staleRecord = await endpointRecord(action.endpointId);
        if (!staleRecord) return false;
        await withCredentialMutationLease(
          staleRecord.endpoint,
          async (credentialLease) => {
            await db.transaction(async (tx) => {
              await credentialLease.assertOwned(tx);
              await notifyChatActionWork(tx, "slash_task_start");
              await tx
                .update(chatActions)
                .set({
                  status: "delivery_unknown",
                  result: {
                    ...(action.result ?? {}),
                    code: "slash_task_delivery_unknown",
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, action.id),
                    eq(chatActions.status, "resolving"),
                    eq(chatActions.updatedAt, action.updatedAt),
                    lte(
                      chatActions.updatedAt,
                      new Date(
                        Date.now() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS,
                      ),
                    ),
                  ),
                );
              await credentialLease.assertOwned(tx);
            });
          },
        );
      }
      return false;
    }
    if (action.status === "validating") {
      if (
        action.updatedAt.getTime() <=
        Date.now() - SLACK_COMMAND_POST_STALE_MS
      ) {
        const staleRecord = await endpointRecord(action.endpointId);
        if (!staleRecord) return false;
        await withCredentialMutationLease(
          staleRecord.endpoint,
          async (credentialLease) => {
            await db.transaction(async (tx) => {
              await credentialLease.assertOwned(tx);
              await notifyChatActionWork(tx, "slash_task_start");
              await tx
                .update(chatActions)
                .set({ status: "queued", updatedAt: new Date() })
                .where(
                  and(
                    eq(chatActions.id, action.id),
                    eq(chatActions.status, "validating"),
                    eq(chatActions.updatedAt, action.updatedAt),
                    lte(
                      chatActions.updatedAt,
                      new Date(Date.now() - SLACK_COMMAND_POST_STALE_MS),
                    ),
                  ),
                );
              await credentialLease.assertOwned(tx);
            });
          },
        );
      }
      return false;
    }
    if (action.status !== "queued") return false;
    const retryAt =
      typeof action.result?.retryAt === "string"
        ? new Date(action.result.retryAt)
        : null;
    if (
      retryAt &&
      !Number.isNaN(retryAt.getTime()) &&
      retryAt.getTime() > Date.now()
    ) {
      return false;
    }
    const attempt =
      (typeof action.result?.attemptCount === "number" &&
      Number.isSafeInteger(action.result.attemptCount)
        ? Math.max(0, action.result.attemptCount)
        : 0) + 1;

    const [claimed] = await db.transaction(async (tx) => {
      await notifyChatActionWork(tx, "slash_task_start");
      return tx
        .update(chatActions)
        .set({
          status: "validating",
          result: { attemptCount: attempt },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(chatActions.id, action.id),
            eq(chatActions.kind, "slash_task_start"),
            eq(chatActions.status, action.status),
          ),
        )
        .returning();
    });
    if (!claimed) return false;
    action = claimed;

    const recovery = slackSlashTaskRecoveryPayload(action.payload);
    const initialRecord = await endpointRecord(action.endpointId);
    if (
      !recovery ||
      !initialRecord ||
      initialRecord.endpoint.provider !== "slack"
    ) {
      await db.transaction(async (tx) => {
        await notifyChatActionWork(tx, "slash_task_start");
        return tx
          .update(chatActions)
          .set({
            status: "failed",
            result: {
              code: "slash_task_provider_context_missing",
              retryable: false,
              attemptCount: attempt,
            },
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(chatActions.id, action.id),
              eq(chatActions.status, "validating"),
              sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
            ),
          );
      });
      return true;
    }
    let providerPostStarted = false;
    let transportClaimed = false;
    let failureResource: ResourceRow | null = null;
    let failureRuntimeFence = runtimeContextForRecord(initialRecord);
    let failureSettledUnderLease = false;
    let confirmedActionId: string | null = null;
    try {
      const processed = await withCredentialMutationLease(
        initialRecord.endpoint,
        async (credentialLease) => {
          const record = await endpointRecord(action.endpointId);
          if (!record || record.endpoint.provider !== "slack") {
            await db.transaction(async (tx) => {
              await notifyChatActionWork(tx, "slash_task_start");
              return tx
                .update(chatActions)
                .set({
                  status: "failed",
                  result: {
                    code: "slash_task_provider_context_missing",
                    retryable: false,
                    attemptCount: attempt,
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, action.id),
                    eq(chatActions.status, "validating"),
                    sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                  ),
                );
            });
            return true;
          }
          failureRuntimeFence = runtimeContextForRecord(record);
          if (!["verifying", "active"].includes(record.endpoint.status)) {
            const terminallyArchived = record.endpoint.status === "archived";
            await db.transaction(async (tx) => {
              await notifyChatActionWork(tx, "slash_task_start");
              return tx
                .update(chatActions)
                .set({
                  status: terminallyArchived ? "cancelled" : "queued",
                  result: {
                    code: terminallyArchived
                      ? "slash_task_endpoint_archived"
                      : "slash_task_endpoint_waiting",
                    attemptCount: attempt - 1,
                    ...(terminallyArchived
                      ? {}
                      : {
                          retryAt: new Date(Date.now() + 5_000).toISOString(),
                        }),
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, action.id),
                    eq(chatActions.status, "validating"),
                    sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                  ),
                );
            });
            return false;
          }

          const principal = action.principalId
            ? await db
                .select()
                .from(chatExternalPrincipals)
                .where(
                  and(
                    eq(chatExternalPrincipals.id, action.principalId),
                    eq(
                      chatExternalPrincipals.companyId,
                      record.endpoint.companyId,
                    ),
                    eq(chatExternalPrincipals.provider, "slack"),
                    eq(
                      chatExternalPrincipals.providerAccountId,
                      record.endpoint.providerAccountId ?? "unknown",
                    ),
                  ),
                )
                .then((rows) => rows[0] ?? null)
            : null;
          let principalAllowed = false;
          if (principal && !principal.isBot && principal.kind === "user") {
            const link = await db
              .select({
                paperclipUserId: chatIdentityLinks.paperclipUserId,
                status: chatIdentityLinks.status,
              })
              .from(chatIdentityLinks)
              .where(
                and(
                  eq(chatIdentityLinks.endpointId, record.endpoint.id),
                  eq(chatIdentityLinks.principalId, principal.id),
                ),
              )
              .then((rows) => rows[0] ?? null);
            if (link?.status === "linked" && link.paperclipUserId) {
              principalAllowed = await db
                .select({ id: companyMemberships.id })
                .from(companyMemberships)
                .where(
                  and(
                    eq(companyMemberships.companyId, record.endpoint.companyId),
                    eq(companyMemberships.principalType, "user"),
                    eq(companyMemberships.principalId, link.paperclipUserId),
                    eq(companyMemberships.status, "active"),
                    ne(companyMemberships.membershipRole, "viewer"),
                  ),
                )
                .then((rows) => rows.length > 0);
            } else if (record.endpoint.allowUnlinkedPeople) {
              principalAllowed = await sponsorAllowsGuest(record.endpoint);
            }
          }

          const rawChannelId = recovery.channelId.replace(/^slack:/, "");
          const isDirectMessage = /^D[A-Z0-9]+$/i.test(rawChannelId);
          const resource = await db
            .select()
            .from(chatEndpointResources)
            .where(
              and(
                eq(chatEndpointResources.endpointId, record.endpoint.id),
                eq(chatEndpointResources.providerResourceId, rawChannelId),
              ),
            )
            .then((rows) => rows[0] ?? null);
          failureResource = resource;
          const destinationAllowed = isDirectMessage
            ? record.endpoint.allowDirectMessages
            : nonDirectDestinationAllowed(record.endpoint, resource);
          if (!principalAllowed || !destinationAllowed) {
            await db.transaction(async (tx) => {
              await notifyChatActionWork(tx, "slash_task_start");
              return tx
                .update(chatActions)
                .set({
                  status: "cancelled",
                  result: {
                    code: "slash_task_no_longer_authorized",
                    attemptCount: attempt,
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, action.id),
                    eq(chatActions.status, "validating"),
                    sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                  ),
                );
            });
            return true;
          }

          const endpointRuntime = await runtimeFor(record.endpoint);
          const baseThread = endpointRuntime.thread(`slack:${rawChannelId}:`);
          const authorizationSnapshot = await db.transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            const currentEndpoint = await runtimeCallbackEndpoint(
              tx,
              record.endpoint.id,
              runtimeContextForRecord(record),
              ["verifying", "active"],
            );
            const currentResource = currentEndpoint
              ? await tx
                  .select()
                  .from(chatEndpointResources)
                  .where(
                    and(
                      eq(
                        chatEndpointResources.companyId,
                        currentEndpoint.companyId,
                      ),
                      eq(chatEndpointResources.endpointId, currentEndpoint.id),
                      eq(
                        chatEndpointResources.providerResourceId,
                        rawChannelId,
                      ),
                    ),
                  )
                  .for("update")
                  .then((rows) => rows[0] ?? null)
              : null;
            const currentAuthorization =
              currentEndpoint && action!.principalId
                ? await lockCurrentPrincipalAuthorization(
                    tx,
                    currentEndpoint,
                    action!.principalId,
                  )
                : null;
            const currentDestinationAllowed = currentEndpoint
              ? isDirectMessage
                ? currentEndpoint.allowDirectMessages
                : nonDirectDestinationAllowed(currentEndpoint, currentResource)
              : false;
            if (
              !currentEndpoint ||
              !currentAuthorization?.allowed ||
              !currentDestinationAllowed
            ) {
              await notifyChatActionWork(tx, "slash_task_start");
              await tx
                .update(chatActions)
                .set({
                  status: "cancelled",
                  result: {
                    code: "slash_task_no_longer_authorized",
                    attemptCount: attempt,
                  },
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(chatActions.id, action!.id),
                    eq(chatActions.status, "validating"),
                    sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                  ),
                );
              return null;
            }

            failureResource = currentResource;
            await notifyChatActionWork(tx, "slash_task_start");
            const [transportClaim] = await tx
              .update(chatActions)
              .set({
                status: "resolving",
                result: {
                  attemptCount: attempt,
                  authorizedUserId: currentAuthorization.userId,
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action!.id),
                  eq(chatActions.status, "validating"),
                  sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                ),
              )
              .returning({ id: chatActions.id });
            return transportClaim
              ? { authorizedUserId: currentAuthorization.userId }
              : null;
          });
          if (!authorizationSnapshot) return false;

          // `resolving` is the durable, single-owner transport claim. The
          // authorization snapshot above commits and releases every row lock
          // before Slack I/O starts. A crash after Slack accepts the post is
          // quarantined as delivery_unknown and is never replayed implicitly.
          transportClaimed = true;
          providerPostStarted = true;
          let starter: Awaited<ReturnType<typeof baseThread.post>>;
          try {
            starter = await baseThread.post("Starting a task…");
          } catch (error) {
            try {
              await finalizeSlackTaskStartFailure({
                actionId: action.id,
                actionStatus: "resolving",
                attempt,
                connectionId: record.endpoint.connectionId,
                credentialLease,
                endpoint: record.endpoint,
                error,
                providerAttempted: true,
                resource: failureResource,
                runtimeFence: failureRuntimeFence,
              });
              failureSettledUnderLease = true;
            } catch {
              // If ownership was reclaimed while Slack was in flight, the
              // outer recovery path reacquires the endpoint lease and settles
              // the attempt without applying stale health state.
            }
            throw error;
          }
          const threadId = slackTaskStarterThreadId(rawChannelId, starter.id);
          const [providerConfirmed] = await db.transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            await notifyChatActionWork(tx, "slash_task_start");
            return tx
              .update(chatActions)
              .set({
                status: "provider_confirmed",
                result: {
                  attemptCount: attempt,
                  authorizedUserId: authorizationSnapshot.authorizedUserId,
                  threadId,
                  providerMessageId: starter.id,
                },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  eq(chatActions.status, "resolving"),
                  sql`(${chatActions.result}->>'attemptCount')::int = ${attempt}`,
                ),
              )
              .returning();
          });
          if (!providerConfirmed) {
            throw new Error(
              "Slack task-start ownership changed after provider acceptance",
            );
          }
          // Provider transport and its durable confirmation remain fenced by
          // the credential lease. Paperclip-only task admission happens after
          // this callback returns and releases that lease: normal admission
          // stages a receipt reaction, whose independently fenced worker must
          // acquire the same lease and would otherwise self-deadlock here.
          confirmedActionId = providerConfirmed.id;
          return true;
        },
      );
      if (typeof confirmedActionId === "string") {
        await admitConfirmedSlackTaskStart(confirmedActionId, ingressOnly);
      }
      return processed;
    } catch (error) {
      if (!failureSettledUnderLease) {
        await withCredentialMutationLease(
          initialRecord.endpoint,
          async (credentialLease) => {
            await finalizeSlackTaskStartFailure({
              actionId: action.id,
              actionStatus: transportClaimed ? "resolving" : "validating",
              attempt,
              connectionId: initialRecord.endpoint.connectionId,
              credentialLease,
              endpoint: initialRecord.endpoint,
              error,
              providerAttempted: providerPostStarted,
              resource: failureResource,
              runtimeFence: failureRuntimeFence,
            });
          },
        );
      }
      throw error;
    }
  }

  async function processPendingSlackTaskStarts(limit = 25) {
    const actions = await db.select({ id: chatActions.id }).from(chatActions)
      .leftJoin(chatEndpoints, and(eq(chatEndpoints.id, chatActions.endpointId), eq(chatEndpoints.companyId, chatActions.companyId)))
      .where(dueChatAction("slash_task_start"))
      .orderBy(asc(chatActions.createdAt)).limit(limit);
    let processed = 0;
    for (let offset = 0; offset < actions.length; offset += 4) {
      const results = await Promise.all(
        actions.slice(offset, offset + 4).map(async (action) => {
          try {
            return await processSlackTaskStart(action.id);
          } catch (error) {
            logger.warn(
              { actionId: action.id, error: redactError(error) },
              "Slack task start will retry or await explicit resolution",
            );
            return false;
          }
        }),
      );
      processed += results.filter(Boolean).length;
    }
    return processed;
  }
  return { latestSlackDmControlThreadId, finalizeSlackTaskStartFailure, admitConfirmedSlackTaskStart, processSlackTaskStart, processPendingSlackTaskStarts };
}

export function slackTaskStartActivityStatus(action: {
  status: string;
  updatedAt: Date;
}): string {
  const age = Date.now() - action.updatedAt.getTime();
  if (action.status === "validating" && age >= SLACK_COMMAND_POST_STALE_MS) {
    return "queued";
  }
  if (
    (action.status === "received" && age >= SLACK_COMMAND_POST_STALE_MS) ||
    (action.status === "resolving" &&
      age >= SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS)
  ) {
    return "delivery_unknown";
  }
  return action.status;
}
