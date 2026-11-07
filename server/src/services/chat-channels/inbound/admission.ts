import { createTeamsDestinationAdmission } from "../microsoft-teams/destination-admission.js";
import { createTelegramDestinationAdmission } from "../telegram/destination-admission.js";
import { createPhotonDestinationAdmission } from "../imessage-photon/destination-admission.js";

import { deliveryContentWasRedacted } from "./delivery-ledger.js";

import type { EndpointRow, DbTransaction, DbOrTransaction, InboundRuntimeContext } from "../runtime-types.js";

import { notifyChatDeliveryWork } from "../../chat-work-notifications.js";

import {
  githubMessageAddressesAnotherRecipient,
} from "../../chat-github-events.js";

import {
  createHash,
} from "node:crypto";
import {
  and,
  eq,
  sql,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import type {
  Message,
  Thread,
} from "chat";

import type { DiscordGatewayOwnership } from "../runtime-types.js";
import type { InboundEnvelope } from "./envelope.js";
import type { ChatSdkMessageCallbackEvent } from "../../chat-sdk-runtime.js";

type InboundAdmissionInput = {
  endpoint: EndpointRow;
  thread: Thread;
  message: Message;
  trigger: ChatSdkMessageCallbackEvent["trigger"];
  runtimeContext?: InboundRuntimeContext;
  admittedDeliveryId: string | null;
  deferDrainUntilFollowup: boolean;
  scheduledAt: number | null;
  envelope: Pick<InboundEnvelope, "providerEventId" | "addressed" | "eventKind" | "normalized" | "redactedDestinationNormalized" | "githubAutomatic" | "githubIssue">;
};
type GatewayAdmissionState = {
  lost?: DiscordGatewayOwnership;
  renewed?: { expiresAt: Date; ownership: DiscordGatewayOwnership };
};
type InboundAdmissionOptions = {
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  leasedChatProvider: (provider: string) => boolean;
  renewDiscordGatewayOwnershipForMessageAdmission: (tx: DbTransaction, endpointId: string, context: InboundRuntimeContext) => Promise<{ kind: "owned"; expiresAt: Date; ownership: DiscordGatewayOwnership } | { kind: "lost"; ownership: DiscordGatewayOwnership | null }>;
  ensureResource: (endpoint: EndpointRow, thread: Thread, enableForSetup: boolean, database?: DbOrTransaction) => Promise<typeof chatEndpointResources.$inferSelect>;
  DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS: number;
};
export function createInboundAdmission(db: Db, options: InboundAdmissionOptions) {
  const { runtimeGeneration, credentialFingerprint, leasedChatProvider, renewDiscordGatewayOwnershipForMessageAdmission, ensureResource, DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS } = options;
  const { admitTeamsDestination } = createTeamsDestinationAdmission({ ensureResource });
  const { admitTelegramDestination } = createTelegramDestinationAdmission({ ensureResource });
  const { admitPhotonDestination } = createPhotonDestinationAdmission({ ensureResource });
  async function admitInboundMessage(input: InboundAdmissionInput, discordGatewayAdmissionState: GatewayAdmissionState) {
    const { endpoint, thread, message, trigger, runtimeContext, admittedDeliveryId, deferDrainUntilFollowup, scheduledAt, envelope } = input;
    const { providerEventId, addressed, eventKind, normalized, redactedDestinationNormalized, githubAutomatic, githubIssue } = envelope;
    return await db.transaction(async (tx) => {
      const currentEndpoint = await tx
        .select({
          status: chatEndpoints.status,
          setup: chatEndpoints.setup,
          allowDirectMessages: chatEndpoints.allowDirectMessages,
          requireAtMention: chatEndpoints.requireAtMention,
          allowGroupChats: chatEndpoints.allowGroupChats,
          botUsername: chatEndpoints.botUsername,
        })
        .from(chatEndpoints)
        .where(eq(chatEndpoints.id, endpoint.id))
        .for("update")
        .then((rows) => rows[0] ?? null);
      if (!currentEndpoint) return null;
      // An SDK callback can finish parsing after a pause/resume cycle. Each
      // runtime captures the durable endpoint generation at registration;
      // resume advances it under the same row lock used by admission. This
      // rejects stale callbacks without relying on provider/server clock sync.
      const currentRuntimeGeneration = runtimeGeneration(currentEndpoint.setup);
      const currentCredentialFingerprint = runtimeContext
        ? await tx
            .select({ refs: toolConnections.credentialSecretRefs })
            .from(toolConnections)
            .where(
              and(
                eq(toolConnections.companyId, endpoint.companyId),
                eq(toolConnections.id, endpoint.connectionId),
              ),
            )
            .then((rows) => credentialFingerprint(rows[0]?.refs ?? []))
        : null;
      const staleActivation =
        runtimeContext !== undefined &&
        (runtimeContext.generation !== currentRuntimeGeneration ||
          runtimeContext.credentialFingerprint !==
            currentCredentialFingerprint);
      const endpointAccepting =
        ["verifying", "active"].includes(currentEndpoint.status) &&
        !staleActivation;
      if (
        endpointAccepting &&
        leasedChatProvider(endpoint.provider) &&
        runtimeContext &&
        !admittedDeliveryId
      ) {
        // The first process-local ownership check can precede a host pause.
        // Reclaim the same durable token while the endpoint admission row is
        // locked so a standby takeover cannot be followed by an obsolete
        // callback write. This renews only the exact token that authenticated
        // the callback; generation and credential checks above remain intact.
        const gatewayOwnership =
          await renewDiscordGatewayOwnershipForMessageAdmission(
            tx,
            endpoint.id,
            runtimeContext,
          );
        if (gatewayOwnership.kind === "lost") {
          if (gatewayOwnership.ownership) {
            discordGatewayAdmissionState.lost = gatewayOwnership.ownership;
          }
          return null;
        }
        discordGatewayAdmissionState.renewed = gatewayOwnership;
      }
      let provisionalTeamsSetupReply = false;
      let destinationAccepting = true;
      if (endpointAccepting && thread.isDM) {
        destinationAccepting = currentEndpoint.allowDirectMessages;
      }
      if (
        endpointAccepting &&
        endpoint.provider === "microsoft-teams" &&
        !thread.isDM
      ) {
        ({ destinationAccepting, provisionalTeamsSetupReply } = await admitTeamsDestination({ endpoint, currentEndpoint, thread, message, addressed }, tx));
      }
      if (
        endpointAccepting &&
        endpoint.provider === "telegram" &&
        !thread.isDM
      ) {
        destinationAccepting = await admitTelegramDestination({ endpoint, currentEndpoint, thread, addressed }, tx);
      }
      if (
        endpointAccepting &&
        endpoint.provider === "imessage-photon" &&
        !thread.isDM
      ) {
        destinationAccepting = await admitPhotonDestination({ endpoint, currentEndpoint, thread }, tx);
      }
      const mentionRequired =
        endpoint.provider === "slack" &&
        currentEndpoint.requireAtMention &&
        !thread.isDM &&
        trigger !== "mention" &&
        message.isMention !== true;
      // GitHub sends the same comment to every installed App. Subscribed
      // conversations are a fallback for unaddressed replies, not permission
      // to wake every bot when the person addresses a different recipient.
      // Recheck inside durable admission so recovered deliveries follow the
      // same company-scoped routing decision before any task or reaction.
      const githubAddressedElsewhere =
        endpointAccepting &&
        endpoint.provider === "github" &&
        !addressed &&
        !githubAutomatic &&
        !githubIssue &&
        (await githubMessageAddressesAnotherRecipient(tx, {
          id: endpoint.id,
          companyId: endpoint.companyId,
          botUsername: currentEndpoint.botUsername,
        }, message.text));
      const accepting = endpointAccepting && destinationAccepting && !githubAddressedElsewhere && !mentionRequired;
      const redactDestinationDelivery =
        githubAddressedElsewhere || mentionRequired || (!accepting && thread.isDM) ||

        (!thread.isDM &&
          (endpoint.provider === "microsoft-teams" ||
            endpoint.provider === "telegram" ||
            endpoint.provider === "imessage-photon") &&
          (!accepting || provisionalTeamsSetupReply));
      const ignoredAt = accepting ? null : new Date();
      const inactiveReason = !endpointAccepting
        ? staleActivation
          ? "Connection activation changed before admission"
          : "Connection is not active"
        : githubAddressedElsewhere
          ? "GitHub message explicitly addresses a different recipient"
          : mentionRequired
            ? "Message did not @mention the bot"
          : endpoint.provider === "telegram" && !thread.isDM && !addressed
            ? "Message did not address the agent"
            : "Destination is not enabled in Paperclip";
      let candidate = admittedDeliveryId
        ? await tx
            .select()
            .from(chatDeliveries)
            .where(
              and(
                eq(chatDeliveries.id, admittedDeliveryId),
                eq(chatDeliveries.endpointId, endpoint.id),
                eq(chatDeliveries.providerEventId, providerEventId),
              ),
            )
            .for("update")
            .then((rows) => rows[0] ?? null)
        : null;
      if (!admittedDeliveryId) {
        await notifyChatDeliveryWork(tx);
        const [delivery] = await tx
          .insert(chatDeliveries)
          .values({
            companyId: endpoint.companyId,
            endpointId: endpoint.id,
            providerEventId,
            deduplicationKey: createHash("sha256")
              .update(providerEventId)
              .digest("hex"),
            eventKind,
            normalizedEvent: redactDestinationDelivery
              ? redactedDestinationNormalized
              : deferDrainUntilFollowup && accepting
                ? {
                    ...normalized,
                    providerThreadPending: true,
                  }
                : normalized,
            state: accepting
              ? deferDrainUntilFollowup
                ? "retry"
                : "received"
              : "filtered",
            nextAttemptAt:
              accepting && deferDrainUntilFollowup
                ? new Date(
                    Date.now() + DISCORD_ROOT_THREAD_CONFIRMATION_DELAY_MS,
                  )
                : accepting && scheduledAt
                  ? new Date(scheduledAt)
                  : null,
            redactedError:
              accepting && deferDrainUntilFollowup
                ? "Waiting for Discord thread creation confirmation"
                : accepting
                  ? null
                  : inactiveReason,
            processedAt: ignoredAt,
          })
          .onConflictDoNothing()
          .returning();
        candidate = delivery ?? null;
      }
      if (!candidate && !admittedDeliveryId) {
        const existingDelivery = await tx
          .select()
          .from(chatDeliveries)
          .where(
            and(
              eq(chatDeliveries.endpointId, endpoint.id),
              eq(chatDeliveries.providerEventId, providerEventId),
            ),
          )
          .then((rows) => rows[0] ?? null);
        if (existingDelivery) {
          const hydrateTeamsDelivery =
            endpoint.provider === "microsoft-teams" &&
            !thread.isDM &&
            accepting &&
            !provisionalTeamsSetupReply &&
            ["received", "retry", "processing"].includes(
              existingDelivery.state,
            ) &&
            deliveryContentWasRedacted(existingDelivery.normalizedEvent);
          await notifyChatDeliveryWork(tx);
          [candidate] = await tx
            .update(chatDeliveries)
            .set({
              // Increment under PostgreSQL's row lock so simultaneous handler
              // fanout and provider retries cannot lose duplicate telemetry.
              normalizedEvent: redactDestinationDelivery
                ? sql`${JSON.stringify(redactedDestinationNormalized)}::jsonb
                    || jsonb_build_object(
                      'deduplication',
                      jsonb_build_object(
                        'duplicateCount',
                        coalesce((${chatDeliveries.normalizedEvent}#>>'{deduplication,duplicateCount}')::integer, 0) + 1,
                        'lastDuplicateAt',
                        ${new Date().toISOString()}::text
                      )
                    )`
                : hydrateTeamsDelivery
                  ? sql`${JSON.stringify(normalized)}::jsonb
                    || jsonb_build_object(
                      'deduplication',
                      coalesce(${chatDeliveries.normalizedEvent}->'deduplication', '{}'::jsonb)
                        || jsonb_build_object(
                          'duplicateCount',
                          coalesce((${chatDeliveries.normalizedEvent}#>>'{deduplication,duplicateCount}')::integer, 0) + 1,
                          'lastDuplicateAt',
                          ${new Date().toISOString()}::text
                        )
                    )`
                  : sql`coalesce(${chatDeliveries.normalizedEvent}, '{}'::jsonb)
                    || jsonb_build_object(
                      'deduplication',
                      coalesce(${chatDeliveries.normalizedEvent}->'deduplication', '{}'::jsonb)
                        || jsonb_build_object(
                          'duplicateCount',
                          coalesce((${chatDeliveries.normalizedEvent}#>>'{deduplication,duplicateCount}')::integer, 0) + 1,
                          'lastDuplicateAt',
                          ${new Date().toISOString()}::text
                        )
                    )`,
              ...(!accepting &&
              ["received", "retry"].includes(existingDelivery.state)
                ? {
                    state: "filtered" as const,
                    nextAttemptAt: null,
                    redactedError: inactiveReason,
                    processedAt: ignoredAt,
                  }
                : {}),
              updatedAt: new Date(),
            })
            .where(eq(chatDeliveries.id, existingDelivery.id))
            .returning();
        }
      }
      if (
        candidate &&
        admittedDeliveryId &&
        accepting &&
        !provisionalTeamsSetupReply &&
        endpoint.provider === "microsoft-teams" &&
        !thread.isDM &&
        ["received", "retry", "processing"].includes(candidate.state) &&
        deliveryContentWasRedacted(candidate.normalizedEvent)
      ) {
        [candidate] = await tx
          .update(chatDeliveries)
          .set({ normalizedEvent: normalized, updatedAt: new Date() })
          .where(eq(chatDeliveries.id, candidate.id))
          .returning();
      }
      if (
        candidate &&
        admittedDeliveryId &&
        !accepting &&
        ["received", "retry", "processing"].includes(candidate.state)
      ) {
        await notifyChatDeliveryWork(tx);
        [candidate] = await tx
          .update(chatDeliveries)
          .set({
            state: "filtered",
            ...(redactDestinationDelivery
              ? {
                  normalizedEvent: redactedDestinationNormalized,
                  principalId: null,
                }
              : {}),
            nextAttemptAt: null,
            redactedError: inactiveReason,
            processedAt: ignoredAt,
            updatedAt: new Date(),
          })
          .where(eq(chatDeliveries.id, candidate.id))
          .returning();
      }
      if (!accepting && ignoredAt) {
        await tx
          .update(chatEndpoints)
          .set({ lastEventAt: ignoredAt, updatedAt: ignoredAt })
          .where(eq(chatEndpoints.id, endpoint.id));
      }
      return {
        accepting,
        candidate: candidate ?? null,
        provisionalTeamsSetupReply,
      };
    });
  }
  return { admitInboundMessage };
}
