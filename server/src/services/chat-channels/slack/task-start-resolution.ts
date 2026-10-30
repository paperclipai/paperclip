import type { EndpointRecord } from "../runtime-types.js";
import { slackSlashTaskRecoveryPayload, slackTaskStarterThreadId } from "./task-start.js";
import { SLACK_COMMAND_POST_STALE_MS, SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS } from "../../chat-action-work.js";
import { notifyChatActionWork } from "../../chat-work-notifications.js";
import { and, eq, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatActions, chatEndpointResources, chatExternalPrincipals, chatIdentityLinks, companyMemberships } from "@paperclipai/db";
import { conflict, notFound } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import type { createSlackTaskStart } from "./task-start.js";
type ResolutionOptions = Pick<Parameters<typeof createSlackTaskStart>[1], "endpointRecord" | "withCredentialMutationLease" | "runtimeFor" | "runtimeContextForRecord" | "runtimeCallbackEndpoint" | "lockCurrentPrincipalAuthorization" | "sponsorAllowsGuest" | "nonDirectDestinationAllowed"> & Pick<ReturnType<typeof createSlackTaskStart>, "finalizeSlackTaskStartFailure" | "admitConfirmedSlackTaskStart"> & { readonly deferWebhookProcessing: boolean | undefined };

export function createSlackTaskStartResolution(db: Db, options: ResolutionOptions) {
  const { endpointRecord, withCredentialMutationLease, runtimeFor, runtimeContextForRecord, runtimeCallbackEndpoint, lockCurrentPrincipalAuthorization, sponsorAllowsGuest, nonDirectDestinationAllowed, finalizeSlackTaskStartFailure, admitConfirmedSlackTaskStart } = options;
  async function resolveSlackTaskStart(
    endpointId: string,
    actionId: string,
    resolution: "mark_delivered" | "retry_anyway" | "cancel",
    userId: string,
    initialRecord: EndpointRecord,
  ) {
    if (initialRecord.endpoint.provider !== "slack") {
      throw conflict("This provider action cannot be resolved here", {
        code: "chat_action_resolution_unsupported",
      });
    }
    if (resolution === "mark_delivered") {
      throw conflict("A Slack task start cannot be marked delivered here", {
        code: "chat_action_resolution_unsupported",
      });
    }

    if (resolution === "cancel") {
      await withCredentialMutationLease(
        initialRecord.endpoint,
        async (credentialLease) => {
          await db.transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            await notifyChatActionWork(tx, "slash_task_start");
            await tx
              .update(chatActions)
              .set({
                status: "delivery_unknown",
                result: { code: "slash_task_delivery_unknown" },
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(chatActions.endpointId, endpointId),
                  eq(chatActions.id, actionId),
                  eq(chatActions.kind, "slash_task_start"),
                  or(
                    and(
                      eq(chatActions.status, "received"),
                      lte(
                        chatActions.updatedAt,
                        new Date(Date.now() - SLACK_COMMAND_POST_STALE_MS),
                      ),
                    ),
                    and(
                      eq(chatActions.status, "resolving"),
                      lte(
                        chatActions.updatedAt,
                        new Date(
                          Date.now() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS,
                        ),
                      ),
                    ),
                  ),
                ),
              );
            await credentialLease.assertOwned(tx);
            const action = await tx
              .select()
              .from(chatActions)
              .where(
                and(
                  eq(chatActions.endpointId, endpointId),
                  eq(chatActions.id, actionId),
                  eq(chatActions.kind, "slash_task_start"),
                ),
              )
              .for("update")
              .then((rows) => rows[0] ?? null);
            if (!action) throw notFound("Provider action not found");
            if (action.status !== "delivery_unknown") {
              throw conflict(
                "Only an unconfirmed provider action needs operator resolution",
                {
                  code: "chat_action_resolution_not_required",
                },
              );
            }
            const now = new Date();
            await notifyChatActionWork(tx, "slash_task_start");
            await tx
              .update(chatActions)
              .set({
                status: "cancelled",
                result: { code: "slash_task_cancelled_by_operator" },
                updatedAt: now,
              })
              .where(
                and(
                  eq(chatActions.id, action.id),
                  eq(chatActions.status, "delivery_unknown"),
                ),
              );
            await logActivity(tx as unknown as Db, {
              companyId: action.companyId,
              actorType: "user",
              actorId: userId,
              action: "chat.slack_command_cancel",
              entityType: "chat_action",
              entityId: action.id,
              details: {
                endpointId,
                previousState: "delivery_unknown",
                nextState: "cancelled",
                duplicateRiskAccepted: false,
              },
            });
            await credentialLease.assertOwned(tx);
          });
        },
      );
      return;
    }

    let confirmedActionId: string | null = null;
    await withCredentialMutationLease(
      initialRecord.endpoint,
      async (credentialLease) => {
        const record = await endpointRecord(endpointId);
        if (!record) throw notFound("Chat endpoint not found");
        if (
          record.endpoint.provider !== "slack" ||
          !["verifying", "active"].includes(record.endpoint.status)
        ) {
          throw conflict(
            "The Slack connection must be active before retrying this action",
            {
              code: "chat_action_endpoint_unavailable",
            },
          );
        }
        const action = await db
          .select()
          .from(chatActions)
          .where(
            and(
              eq(chatActions.endpointId, endpointId),
              eq(chatActions.id, actionId),
              eq(chatActions.kind, "slash_task_start"),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (!action) throw notFound("Provider action not found");
        const staleActionCanBeNormalized =
          (action.status === "received" &&
            action.updatedAt.getTime() <=
              Date.now() - SLACK_COMMAND_POST_STALE_MS) ||
          (action.status === "resolving" &&
            action.updatedAt.getTime() <=
              Date.now() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS);
        if (
          action.status !== "delivery_unknown" &&
          !staleActionCanBeNormalized
        ) {
          throw conflict(
            "Only an unconfirmed provider action needs operator resolution",
            {
              code: "chat_action_resolution_not_required",
            },
          );
        }
        const recovery = slackSlashTaskRecoveryPayload(action.payload);
        if (!recovery) {
          throw conflict(
            "This action does not contain enough context for an explicit retry",
            {
              code: "chat_action_retry_context_missing",
            },
          );
        }
        if (!action.principalId) {
          throw conflict("The original Slack account is no longer available", {
            code: "chat_action_principal_missing",
          });
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
          throw conflict("The original Slack account is no longer available", {
            code: "chat_action_principal_missing",
          });
        }
        const link = await db
          .select({
            paperclipUserId: chatIdentityLinks.paperclipUserId,
            status: chatIdentityLinks.status,
          })
          .from(chatIdentityLinks)
          .where(
            and(
              eq(chatIdentityLinks.endpointId, endpointId),
              eq(chatIdentityLinks.principalId, principal.id),
            ),
          )
          .then((rows) => rows[0] ?? null);
        let principalAllowed = false;
        if (link?.status === "linked" && link.paperclipUserId) {
          principalAllowed = await db
            .select({ membershipRole: companyMemberships.membershipRole })
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

        const rawChannelId = recovery.channelId.replace(/^slack:/, "");
        const isDirectMessage = /^D[A-Z0-9]+$/i.test(rawChannelId);
        const resource = await db
          .select()
          .from(chatEndpointResources)
          .where(
            and(
              eq(chatEndpointResources.endpointId, endpointId),
              eq(chatEndpointResources.providerResourceId, rawChannelId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        const destinationAllowed = isDirectMessage
          ? record.endpoint.allowDirectMessages
          : nonDirectDestinationAllowed(record.endpoint, resource);
        if (!principalAllowed || !destinationAllowed) {
          throw conflict(
            "The original account or destination is no longer allowed",
            {
              code: "chat_action_no_longer_authorized",
            },
          );
        }

        // Resolve and validate the runtime before claiming the action. A local
        // setup failure at this point cannot have sent anything to Slack and
        // therefore leaves the original ambiguous action untouched.
        const endpointRuntime = await runtimeFor(record.endpoint);
        const baseThread = endpointRuntime.thread(`slack:${rawChannelId}:`);
        const retryAttempt =
          (action.status === "delivery_unknown" &&
          typeof action.result?.attemptCount === "number" &&
          Number.isSafeInteger(action.result.attemptCount)
            ? Math.max(0, action.result.attemptCount)
            : 0) + 1;
        const [claimed] = await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          await notifyChatActionWork(tx, "slash_task_start");
          await tx
            .update(chatActions)
            .set({
              status: "delivery_unknown",
              result: { code: "slash_task_delivery_unknown" },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.endpointId, endpointId),
                eq(chatActions.id, actionId),
                eq(chatActions.kind, "slash_task_start"),
                or(
                  and(
                    eq(chatActions.status, "received"),
                    lte(
                      chatActions.updatedAt,
                      new Date(Date.now() - SLACK_COMMAND_POST_STALE_MS),
                    ),
                  ),
                  and(
                    eq(chatActions.status, "resolving"),
                    lte(
                      chatActions.updatedAt,
                      new Date(
                        Date.now() - SLACK_COMMAND_EXPLICIT_RETRY_STALE_MS,
                      ),
                    ),
                  ),
                ),
              ),
            );
          await credentialLease.assertOwned(tx);
          const current = await tx
            .select()
            .from(chatActions)
            .where(
              and(
                eq(chatActions.endpointId, endpointId),
                eq(chatActions.id, actionId),
                eq(chatActions.kind, "slash_task_start"),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null);
          if (!current) throw notFound("Provider action not found");
          if (current.status !== "delivery_unknown") {
            throw conflict(
              "Only an unconfirmed provider action needs operator resolution",
              {
                code: "chat_action_resolution_not_required",
              },
            );
          }
          const currentEndpoint = await runtimeCallbackEndpoint(
            tx,
            record.endpoint.id,
            runtimeContextForRecord(record),
            ["verifying", "active"],
          );
          const currentResource =
            currentEndpoint && !isDirectMessage
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
          const currentAuthorization = currentEndpoint
            ? await lockCurrentPrincipalAuthorization(
                tx,
                currentEndpoint,
                action.principalId!,
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
            throw conflict(
              "The original account or destination is no longer allowed",
              {
                code: "chat_action_no_longer_authorized",
              },
            );
          }
          await notifyChatActionWork(tx, "slash_task_start");
          const rows = await tx
            .update(chatActions)
            .set({
              status: "resolving",
              result: {
                code: "slash_task_retry_requested",
                attemptCount: retryAttempt,
                authorizedUserId: currentAuthorization.userId,
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, current.id),
                eq(chatActions.status, "delivery_unknown"),
              ),
            )
            .returning();
          await logActivity(tx as unknown as Db, {
            companyId: current.companyId,
            actorType: "user",
            actorId: userId,
            action: "chat.slack_command_retry_anyway",
            entityType: "chat_action",
            entityId: current.id,
            details: {
              endpointId,
              previousState: "delivery_unknown",
              nextState: "resolving",
              duplicateRiskAccepted: true,
            },
          });
          await credentialLease.assertOwned(tx);
          return rows;
        });
        if (!claimed) {
          throw conflict("This provider action is already being resolved", {
            code: "chat_action_resolution_conflict",
          });
        }

        let starter: { id: string; threadId: string };
        try {
          starter = await baseThread.post("Starting a task…");
        } catch (error) {
          await finalizeSlackTaskStartFailure({
            actionId: action.id,
            actionStatus: "resolving",
            attempt: retryAttempt,
            connectionId: record.endpoint.connectionId,
            credentialLease,
            endpoint: record.endpoint,
            error,
            providerAttempted: true,
            resource,
            runtimeFence: runtimeContextForRecord(record),
          });
          throw error;
        }
        const [completed] = await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          await notifyChatActionWork(tx, "slash_task_start");
          return tx
            .update(chatActions)
            .set({
              // The provider send is now confirmed, but task admission is a
              // separate durable phase. Persist this fence before constructing the
              // Paperclip delivery so a crash cannot turn into another Slack post.
              status: "provider_confirmed",
              result: {
                attemptCount: retryAttempt,
                authorizedUserId: claimed.result?.authorizedUserId ?? null,
                threadId: slackTaskStarterThreadId(rawChannelId, starter.id),
                providerMessageId: starter.id,
              },
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(chatActions.id, action.id),
                eq(chatActions.status, "resolving"),
                sql`(${chatActions.result}->>'attemptCount')::int = ${retryAttempt}`,
              ),
            )
            .returning({ id: chatActions.id });
        });
        // A deliberately cancelled action wins over a provider response that
        // arrived only after the operator's stale-action window. Keep the Slack
        // starter as an orphan rather than creating work the operator cancelled.
        if (!completed) return;
        confirmedActionId = action.id;
      },
    );
    if (typeof confirmedActionId === "string") {
      await admitConfirmedSlackTaskStart(
        confirmedActionId,
        options.deferWebhookProcessing === true,
      );
    }
  }
  return { resolveSlackTaskStart };
}
