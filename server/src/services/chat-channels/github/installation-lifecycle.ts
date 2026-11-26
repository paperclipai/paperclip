import type { VerifiedProviderIdentity } from "../runtime-types.js";

import type { EndpointRow, DbTransaction, LifecycleRuntimeFence, InternalSetupState } from "../runtime-types.js";

import { createChatResourceReconciliation } from "../resource-reconciliation.js";

import { notifyChatDeliveryWork } from "../../chat-work-notifications.js";

import { type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import {
  and,
  eq,
  inArray,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatConversations,
  chatDeliveries,
  chatEndpointResources,
  chatEndpoints,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  ChatProvider,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import {
  conflict,
  notFound,
} from "../../../errors.js";

import { redactSensitiveText } from "../../../redaction.js";

import {
  type ChatProviderLifecycleEffect,
} from "../../chat-provider-lifecycle.js";

import type { EndpointRecord, PreparedProviderInventory } from "../runtime-types.js";

type GitHubInstallationLifecycleOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  resolveCredentials: (endpoint: EndpointRow) => Promise<Record<string, string>>;
  runtimeCallbackEndpoint: (tx: DbTransaction, endpointId: string, context: LifecycleRuntimeFence, statuses: EndpointRow["status"][]) => Promise<EndpointRow | null>;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  verifyCredentials: (provider: ChatProvider, credentials: Record<string, string>) => Promise<VerifiedProviderIdentity>;
  legacyGitHubLabelsMatchVerifiedCredentials: (current: VerifiedProviderIdentity, verified: VerifiedProviderIdentity) => boolean;
  nativeBotIdentityMatches: (provider: ChatProvider, current: VerifiedProviderIdentity, incoming: VerifiedProviderIdentity) => boolean;
  assertNativeBotIdentityAvailable: (endpoint: EndpointRow, identity: VerifiedProviderIdentity) => Promise<void>;
  prepareProviderInventory: (endpoint: EndpointRow, credentials: Record<string, string>) => Promise<PreparedProviderInventory>;
  persistCredentials: (endpoint: EndpointRow, credentials: Record<string, string>, lease: CredentialMutationLeaseGuard, actorUserId?: string | null) => Promise<ToolCredentialSecretRef[]>;
  reconcileProviderResourceRows: ReturnType<typeof createChatResourceReconciliation>["reconcileProviderResourceRows"];
  redactError: (error: unknown) => string;
  normalizedLifecycleWithRuntimeFence: (delivery: typeof chatDeliveries.$inferSelect, fence: LifecycleRuntimeFence) => Record<string, unknown>;
  MAX_ERROR_TEXT: number;
};

type GitHubInstallationLifecycleInput = {
  currentEndpoint: EndpointRow;
  effect: ChatProviderLifecycleEffect;
  credentialLease: CredentialMutationLeaseGuard;
  admittedRuntimeContext: LifecycleRuntimeFence;
  claimed: { id: string };
  candidate: typeof chatDeliveries.$inferSelect;
  onFailurePersisted: () => void;
};

type GitHubInstallationLifecycleOutcome = {
  refreshRuntimeAfterLifecycle: boolean;
  stopRuntimeAfterLifecycle: boolean;
};

export function createGitHubInstallationLifecycle(db: Db, options: GitHubInstallationLifecycleOptions) {
  const { endpointRecord, resolveCredentials, runtimeCallbackEndpoint, runtimeGeneration, credentialFingerprint, verifyCredentials, legacyGitHubLabelsMatchVerifiedCredentials, nativeBotIdentityMatches, assertNativeBotIdentityAvailable, prepareProviderInventory, persistCredentials, reconcileProviderResourceRows, redactError, normalizedLifecycleWithRuntimeFence, MAX_ERROR_TEXT } = options;

  async function applyGitHubInstallationLifecycle(input: GitHubInstallationLifecycleInput): Promise<GitHubInstallationLifecycleOutcome> {
    const { currentEndpoint, effect, credentialLease, admittedRuntimeContext, claimed, candidate } = input;
    let refreshRuntimeAfterLifecycle = false;
    let stopRuntimeAfterLifecycle = false;
    try {
      const currentCredentials =
        await resolveCredentials(currentEndpoint);
      const lifecycleInstallationId =
        effect.kind === "endpoint" &&
        typeof effect.metadata?.installationId === "string"
          ? effect.metadata.installationId
          : null;
      const removesCurrentInstallation =
        effect.kind === "endpoint" &&
        effect.availability === "revoked" &&
        lifecycleInstallationId !== null &&
        lifecycleInstallationId === currentCredentials.installationId;
      const currentInstallationRemovalReason =
        removesCurrentInstallation && effect.kind === "endpoint"
          ? effect.reason
          : null;
      if (removesCurrentInstallation) {
        // A signed deletion for the installation currently bound to
        // this endpoint is authoritative provider truth. Inventory now
        // correctly contains zero active installations, so treating its
        // empty result as a transient discovery failure would strand the
        // endpoint in attention and ask GitHub to redeliver forever.
        // Keep the App key and webhook secret so a later installation
        // event can recover this same immutable bot identity.
        const revoked = await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          const current = await runtimeCallbackEndpoint(
            tx,
            currentEndpoint.id,
            admittedRuntimeContext,
            ["verifying", "active", "attention", "revoked"],
          );
          const revokedAt = new Date();
          if (!current) {
            await notifyChatDeliveryWork(tx);
            const [filtered] = await tx
              .update(chatDeliveries)
              .set({
                state: "filtered",
                processedAt: revokedAt,
                nextAttemptAt: null,
                redactedError:
                  "GitHub installation deletion belonged to a superseded runtime",
                updatedAt: revokedAt,
              })
              .where(
                and(
                  eq(chatDeliveries.id, claimed.id),
                  eq(chatDeliveries.state, "processing"),
                  eq(chatDeliveries.attempts, candidate.attempts + 1),
                ),
              )
              .returning({ id: chatDeliveries.id });
            if (!filtered) {
              throw new Error(
                "GitHub installation deletion ownership changed before stale settlement",
              );
            }
            await credentialLease.assertOwned(tx);
            return false;
          }
          const reason = redactSensitiveText(
            currentInstallationRemovalReason ??
              "GitHub App installation was removed",
          ).slice(0, MAX_ERROR_TEXT);
          await tx
            .update(chatEndpoints)
            .set({
              status: "revoked",
              healthMessage: reason,
              lastError: reason,
              lastEventAt: revokedAt,
              setup: {
                ...current.setup,
                runtimeGeneration: runtimeGeneration(current.setup) + 1,
              } as InternalSetupState,
              updatedAt: revokedAt,
            })
            .where(eq(chatEndpoints.id, current.id));
          await tx
            .update(toolConnections)
            .set({
              status: "disabled",
              enabled: false,
              healthStatus: "failed",
              healthMessage: reason,
              lastError: reason,
              healthCheckedAt: revokedAt,
              updatedAt: revokedAt,
            })
            .where(eq(toolConnections.id, current.connectionId));
          await tx
            .update(chatEndpointResources)
            .set({ availability: "unavailable", updatedAt: revokedAt })
            .where(
              and(
                eq(chatEndpointResources.companyId, current.companyId),
                eq(chatEndpointResources.endpointId, current.id),
              ),
            );
          await tx
            .update(chatConversations)
            .set({ state: "unavailable", updatedAt: revokedAt })
            .where(
              and(
                eq(chatConversations.companyId, current.companyId),
                eq(chatConversations.endpointId, current.id),
                inArray(chatConversations.state, ["active", "waiting"]),
              ),
            );
          await notifyChatDeliveryWork(tx);
          const [processed] = await tx
            .update(chatDeliveries)
            .set({
              state: "processed",
              processedAt: revokedAt,
              redactedError: null,
              nextAttemptAt: null,
              updatedAt: revokedAt,
            })
            .where(
              and(
                eq(chatDeliveries.id, claimed.id),
                eq(chatDeliveries.state, "processing"),
                eq(chatDeliveries.attempts, candidate.attempts + 1),
              ),
            )
            .returning({ id: chatDeliveries.id });
          if (!processed) {
            throw new Error(
              "GitHub installation deletion ownership changed before revocation settlement",
            );
          }
          await credentialLease.assertOwned(tx);
          return true;
        });
        stopRuntimeAfterLifecycle = revoked;
        return { refreshRuntimeAfterLifecycle, stopRuntimeAfterLifecycle };
      }
      const identity = await verifyCredentials(
        "github",
        currentCredentials,
      );
      const upgradingLegacyIdentity =
        !currentEndpoint.botExternalId &&
        legacyGitHubLabelsMatchVerifiedCredentials(
          currentEndpoint,
          identity,
        );
      if (
        !upgradingLegacyIdentity &&
        !nativeBotIdentityMatches("github", currentEndpoint, identity)
      ) {
        throw conflict(
          "The GitHub App identity changed while reconciling this connection",
          {
            code: "chat_bot_identity_changed",
          },
        );
      }
      await assertNativeBotIdentityAvailable(currentEndpoint, identity);
      if (upgradingLegacyIdentity) {
        await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          await tx
            .update(chatEndpoints)
            .set({
              botExternalId: identity.botExternalId,
              updatedAt: new Date(),
            })
            .where(eq(chatEndpoints.id, currentEndpoint.id));
          await credentialLease.assertOwned(tx);
        });
      }

      // GitHub lifecycle payloads are wake-up signals, not provider
      // truth. Re-read the one active App installation and its complete
      // repository inventory while the credential lease excludes secret
      // rotation and every other lifecycle callback for this endpoint.
      const prepared = await prepareProviderInventory(
        currentEndpoint,
        currentCredentials,
      );
      if (
        prepared.credentials.installationId !==
        currentCredentials.installationId
      ) {
        await persistCredentials(
          currentEndpoint,
          prepared.credentials,
          credentialLease,
        );
        refreshRuntimeAfterLifecycle = true;
      }
      if (prepared.inventory)
        await reconcileProviderResourceRows(
          currentEndpoint,
          prepared.inventory,
          credentialLease,
        );

      const canonical = await endpointRecord(currentEndpoint.id);
      if (!canonical) throw notFound("Chat endpoint not found");
      const now = new Date();
      const intentionallyUnavailable =
        canonical.endpoint.status === "paused" ||
        canonical.endpoint.status === "archived" ||
        (canonical.endpoint.status === "attention" && canonical.endpoint.setup.step === "provider_setup") ||
        !canonical.endpoint.setup.webhookVerifiedAt;
      const advanceRuntimeGeneration =
        refreshRuntimeAfterLifecycle ||
        (canonical.endpoint.status === "attention" && canonical.endpoint.setup.step === "provider_setup") ||
        !canonical.endpoint.setup.webhookVerifiedAt;
      await db.transaction(async (tx) => {
        await credentialLease.assertOwned(tx);
        if (intentionallyUnavailable) {
          await tx
            .update(chatEndpoints)
            .set({
              ...(advanceRuntimeGeneration
                ? {
                    setup: {
                      ...canonical.endpoint.setup,
                      runtimeGeneration:
                        runtimeGeneration(canonical.endpoint.setup) + 1,
                    } as InternalSetupState,
                  }
                : {}),
              lastEventAt: now,
              updatedAt: now,
            })
            .where(eq(chatEndpoints.id, canonical.endpoint.id));
        } else {
          const status =
            canonical.endpoint.setup.step === "complete"
              ? "active"
              : "verifying";
          await tx
            .update(chatEndpoints)
            .set({
              status,
              healthMessage:
                status === "active"
                  ? "Connected"
                  : "Waiting for a test conversation",
              lastError: null,
              lastEventAt: now,
              ...(advanceRuntimeGeneration
                ? {
                    setup: {
                      ...canonical.endpoint.setup,
                      runtimeGeneration:
                        runtimeGeneration(canonical.endpoint.setup) + 1,
                    } as InternalSetupState,
                  }
                : {}),
              updatedAt: now,
            })
            .where(eq(chatEndpoints.id, canonical.endpoint.id));
          await tx
            .update(toolConnections)
            .set({
              status: "active",
              enabled: true,
              healthStatus: "healthy",
              healthMessage: "Connected",
              lastError: null,
              healthCheckedAt: now,
              updatedAt: now,
            })
            .where(
              eq(toolConnections.id, canonical.endpoint.connectionId),
            );
        }
        await notifyChatDeliveryWork(tx);
        await tx
          .update(chatDeliveries)
          .set({
            state: "processed",
            processedAt: now,
            redactedError: null,
            nextAttemptAt: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(chatDeliveries.id, claimed.id),
              eq(chatDeliveries.state, "processing"),
              eq(chatDeliveries.attempts, candidate.attempts + 1),
            ),
          );
        await credentialLease.assertOwned(tx);
      });
      if (intentionallyUnavailable) {
        stopRuntimeAfterLifecycle = true;
      }
    } catch (error) {
      const latest = await endpointRecord(currentEndpoint.id);
      const preserveIntentionalState =
        !latest ||
        latest.endpoint.status === "paused" ||
        latest.endpoint.status === "archived" ||
        (latest.endpoint.status === "attention" && latest.endpoint.setup.step === "provider_setup") ||
        !latest.endpoint.setup.webhookVerifiedAt;
      if (!preserveIntentionalState) {
        const failedAt = new Date();
        const failure = redactError(error);
        const nextGeneration =
          runtimeGeneration(latest.endpoint.setup) + 1;
        const retryRuntimeContext: LifecycleRuntimeFence = {
          credentialFingerprint: credentialFingerprint(
            latest.credentialSecretRefs,
          ),
          generation: nextGeneration,
        };
        const terminal = candidate.attempts + 1 >= 5;
        await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          await tx
            .update(chatEndpoints)
            .set({
              status: "attention",
              healthMessage:
                "GitHub App credentials, permissions, events, or identity need attention",
              lastError: failure,
              lastEventAt: failedAt,
              setup: {
                ...latest.endpoint.setup,
                runtimeGeneration: nextGeneration,
              } as InternalSetupState,
              updatedAt: failedAt,
            })
            .where(eq(chatEndpoints.id, currentEndpoint.id));
          await tx
            .update(toolConnections)
            .set({
              status: "disabled",
              enabled: false,
              healthStatus: "degraded",
              healthMessage:
                "GitHub App credentials, permissions, events, or identity need attention",
              lastError: failure,
              healthCheckedAt: failedAt,
              updatedAt: failedAt,
            })
            .where(eq(toolConnections.id, currentEndpoint.connectionId));
          await tx
            .update(chatEndpointResources)
            .set({ availability: "unavailable", updatedAt: failedAt })
            .where(
              and(
                eq(
                  chatEndpointResources.companyId,
                  currentEndpoint.companyId,
                ),
                eq(chatEndpointResources.endpointId, currentEndpoint.id),
              ),
            );
          await tx
            .update(chatConversations)
            .set({ state: "unavailable", updatedAt: failedAt })
            .where(
              and(
                eq(
                  chatConversations.companyId,
                  currentEndpoint.companyId,
                ),
                eq(chatConversations.endpointId, currentEndpoint.id),
                inArray(chatConversations.state, ["active", "waiting"]),
              ),
            );
          await notifyChatDeliveryWork(tx);
          await tx
            .update(chatDeliveries)
            .set({
              state: terminal ? "failed" : "retry",
              normalizedEvent: normalizedLifecycleWithRuntimeFence(
                candidate,
                retryRuntimeContext,
              ),
              redactedError: failure,
              nextAttemptAt: terminal ? null : failedAt,
              updatedAt: failedAt,
            })
            .where(
              and(
                eq(chatDeliveries.id, claimed.id),
                eq(chatDeliveries.state, "processing"),
                eq(chatDeliveries.attempts, candidate.attempts + 1),
              ),
            );
          await credentialLease.assertOwned(tx);
        });
        input.onFailurePersisted();
      }
      throw error;
    }
    return { refreshRuntimeAfterLifecycle, stopRuntimeAfterLifecycle };
  }
  return { applyGitHubInstallationLifecycle };
}
