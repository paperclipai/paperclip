import type { EndpointRow, InternalSetupState } from "../runtime-types.js";

import { chatCredentialMutationLease, type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import {
  randomBytes,
  randomUUID,
} from "node:crypto";
import {
  and,
  eq,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatEndpoints,
  companySecretBindings,
  toolConnections,
} from "@paperclipai/db";
import type {
  ChatEndpointSetupState,
  ToolCredentialSecretRef,
} from "@paperclipai/shared";

import {
  conflict,
  notFound,
  unprocessable,
} from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";

import {
  logActivity,
} from "../../activity-log.js";

import type { EndpointRecord } from "../runtime-types.js";

type GitHubSetupSecretOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  resolveCredentials: (endpoint: EndpointRow) => Promise<Record<string, string>>;
  persistCredentials: (endpoint: EndpointRow, credentials: Record<string, string>, lease: CredentialMutationLeaseGuard, actorUserId?: string | null) => Promise<ToolCredentialSecretRef[]>;
  runtimeGeneration: (setup: ChatEndpointSetupState) => number;
  credentialFingerprint: (refs: ToolCredentialSecretRef[]) => string;
  invalidateRuntime: (endpointId: string) => Promise<boolean>;
  redactError: (error: unknown) => string;
  setupSecretActivityLogger?: typeof logActivity;
  setupSecretCredentialPersistBarrier?: () => Promise<void>;
  setupSecretFinalOwnershipBarrier?: () => Promise<void>;
};

export function createGitHubSetupSecret(db: Db, options: GitHubSetupSecretOptions) {
  const { endpointRecord, withCredentialMutationLease, resolveCredentials, persistCredentials, runtimeGeneration, credentialFingerprint, invalidateRuntime, redactError } = options;


  async function generateSetupSecret(
    endpointId: string,
    actorUserId?: string | null,
  ) {
    const initial = await endpointRecord(endpointId);
    if (!initial) throw notFound("Chat endpoint not found");
    if (initial.endpoint.provider !== "github") {
      throw unprocessable(
        "Setup secret generation is only available for GitHub",
      );
    }
    let committedWebhookSecretRef: ToolCredentialSecretRef | null = null;
    return withCredentialMutationLease(
      initial.endpoint,
      async (credentialLease) => {
        // A competing request may have completed while this request waited for
        // the durable lease. Reload both endpoint state and credential refs only
        // after ownership so each successful rotation starts from its immediate
        // predecessor instead of replacing the credential set from a stale read.
        const record = await endpointRecord(endpointId);
        if (!record) throw notFound("Chat endpoint not found");
        const endpoint = record.endpoint;
        if (
          ![
            "draft",
            "verifying",
            "active",
            "attention",
            "revoked",
            "paused",
          ].includes(endpoint.status)
        ) {
          throw conflict(
            "The GitHub webhook secret cannot be rotated in this connection state",
            {
              code: "chat_endpoint_setup_secret_unavailable",
            },
          );
        }
        const webhookSecret = randomBytes(32).toString("hex");
        // Rotation must fail closed if any existing credential cannot be resolved.
        // Falling back to an empty object here would replace the full credential
        // set with only the new webhook secret and strand an otherwise-live App.
        const existing = await resolveCredentials(endpoint);
        const replacedExistingSecret = record.credentialSecretRefs.some(
          (ref) => ref.configPath === "credentials.webhookSecret",
        );
        const rotatingConfiguredApp =
          Boolean(endpoint.providerAccountId || endpoint.botExternalId) ||
          record.credentialSecretRefs.some((ref) =>
            ["credentials.appId", "credentials.privateKey"].includes(
              ref.configPath,
            ),
          );
        const rotationId = randomUUID();
        const auditDetails = {
          endpointId: endpoint.id,
          provider: endpoint.provider,
          rotationId,
          rotated: rotatingConfiguredApp,
          replacedPrevious: replacedExistingSecret,
        };
        const writeSetupSecretActivity =
          options.setupSecretActivityLogger ?? logActivity;
        // This durable intent is the audit boundary. If it cannot be written,
        // fail before changing state or refs so retry is safe. Endpoint/tool
        // state moves fail-closed before ref replacement. Once refs change, only
        // best-effort work remains and the plaintext must still be returned.
        await db.transaction(async (tx) => {
          await credentialLease.assertOwned(tx);
          await writeSetupSecretActivity(tx as unknown as Db, {
            companyId: endpoint.companyId,
            actorType: "user",
            actorId: actorUserId ?? "board",
            action: "chat_endpoint.setup_secret_rotation_started",
            entityType: "tool_connection",
            entityId: endpoint.connectionId,
            details: auditDetails,
          });
          await credentialLease.assertOwned(tx);
        });
        try {
          if (rotatingConfiguredApp) {
            const updatedAt = new Date();
            await db.transaction(async (tx) => {
              await credentialLease.assertOwned(tx);
              const current = await tx
                .select({ setup: chatEndpoints.setup })
                .from(chatEndpoints)
                .where(eq(chatEndpoints.id, endpoint.id))
                .for("update")
                .then((rows) => rows[0] ?? null);
              if (!current) throw notFound("Chat endpoint not found");
              await tx
                .update(chatEndpoints)
                .set({
                  status: "attention",
                  healthMessage:
                    "Update the GitHub webhook secret, then reconnect this App",
                  lastError: null,
                  setup: {
                    ...current.setup,
                    step: "provider_setup",
                    webhookVerifiedAt: null,
                    runtimeGeneration: runtimeGeneration(current.setup) + 1,
                  } as InternalSetupState,
                  updatedAt,
                })
                .where(eq(chatEndpoints.id, endpoint.id));
              await tx
                .update(toolConnections)
                .set({
                  status: "disabled",
                  enabled: false,
                  healthStatus: "degraded",
                  healthMessage:
                    "GitHub webhook secret rotation needs reconnect",
                  lastError: null,
                  healthCheckedAt: updatedAt,
                  updatedAt,
                })
                .where(eq(toolConnections.id, endpoint.connectionId));
              await credentialLease.assertOwned(tx);
            });
            await invalidateRuntime(endpoint.id).catch(() => undefined);
          } else {
            // Replacing a secret while the operator is still creating the GitHub
            // App is not a live credential rotation. Keep first-time setup in its
            // draft state, clear any ping for the superseded value, and also heal
            // endpoints affected by the earlier pre-connect rotation trap.
            const updatedAt = new Date();
            await db.transaction(async (tx) => {
              await credentialLease.assertOwned(tx);
              const current = await tx
                .select({ setup: chatEndpoints.setup })
                .from(chatEndpoints)
                .where(eq(chatEndpoints.id, endpoint.id))
                .for("update")
                .then((rows) => rows[0] ?? null);
              if (!current) throw notFound("Chat endpoint not found");
              await tx
                .update(chatEndpoints)
                .set({
                  status: "draft",
                  healthMessage: null,
                  lastError: null,
                  setup: {
                    ...current.setup,
                    step: "provider_setup",
                    webhookVerifiedAt: null,
                  },
                  updatedAt,
                })
                .where(eq(chatEndpoints.id, endpoint.id));
              await tx
                .update(toolConnections)
                .set({
                  status: "draft",
                  enabled: false,
                  healthStatus: "unchecked",
                  healthMessage: null,
                  lastError: null,
                  healthCheckedAt: null,
                  updatedAt,
                })
                .where(eq(toolConnections.id, endpoint.connectionId));
              await credentialLease.assertOwned(tx);
            });
          }
          await options.setupSecretCredentialPersistBarrier?.();
          // Make credential refs the final required mutation. Once this returns,
          // only the best-effort completion audit remains, so the request cannot
          // fail after making the newly generated secret authoritative.
          const persistedRefs = await persistCredentials(
            endpoint,
            { ...existing, webhookSecret },
            credentialLease,
            actorUserId,
          );
          committedWebhookSecretRef =
            persistedRefs.find(
              (ref) => ref.configPath === "credentials.webhookSecret",
            ) ?? null;
          if (!committedWebhookSecretRef) {
            throw new Error(
              "GitHub webhook secret was not present after credential persistence",
            );
          }
        } catch (error) {
          await writeSetupSecretActivity(db, {
            companyId: endpoint.companyId,
            actorType: "user",
            actorId: actorUserId ?? "board",
            action: "chat_endpoint.setup_secret_rotation_failed",
            entityType: "tool_connection",
            entityId: endpoint.connectionId,
            details: auditDetails,
          }).catch((auditError) => {
            logger.warn(
              {
                endpointId: endpoint.id,
                error: redactError(auditError),
                rotationId,
              },
              "could not audit failed GitHub setup-secret rotation",
            );
          });
          throw error;
        }
        await db
          .transaction(async (tx) => {
            await credentialLease.assertOwned(tx);
            await writeSetupSecretActivity(tx as unknown as Db, {
              companyId: endpoint.companyId,
              actorType: "user",
              actorId: actorUserId ?? "board",
              action: "chat_endpoint.setup_secret_generated",
              entityType: "tool_connection",
              entityId: endpoint.connectionId,
              details: auditDetails,
            });
            await credentialLease.assertOwned(tx);
          })
          .catch((error) => {
            logger.warn(
              {
                endpointId: endpoint.id,
                error: redactError(error),
                rotationId,
              },
              "GitHub setup secret rotated but completion audit failed",
            );
          });
        return { webhookSecret };
      },
      {
        beforeFinalOwnershipCheck: options.setupSecretFinalOwnershipBarrier,
        recoverCommittedResultAfterLeaseLoss: async () => {
          const committedRef = committedWebhookSecretRef;
          if (!committedRef) return false;
          const authoritative = await db
            .select({ refs: toolConnections.credentialSecretRefs })
            .from(toolConnections)
            .innerJoin(
              companySecretBindings,
              and(
                eq(companySecretBindings.companyId, initial.endpoint.companyId),
                eq(companySecretBindings.targetType, "tool_connection"),
                eq(
                  companySecretBindings.targetId,
                  initial.endpoint.connectionId,
                ),
                eq(companySecretBindings.configPath, committedRef.configPath),
                eq(companySecretBindings.secretId, committedRef.secretId),
                eq(
                  companySecretBindings.versionSelector,
                  String(committedRef.versionSelector ?? "latest"),
                ),
              ),
            )
            .where(
              and(
                eq(toolConnections.companyId, initial.endpoint.companyId),
                eq(toolConnections.id, initial.endpoint.connectionId),
              ),
            )
            .then((rows) => rows[0] ?? null);
          return (
            authoritative?.refs.some(
              (ref) =>
                credentialFingerprint([ref]) ===
                credentialFingerprint([committedRef]),
            ) === true
          );
        },
      },
    );
  }
  return { generateSetupSecret };
}
