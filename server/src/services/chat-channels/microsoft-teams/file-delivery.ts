import { createOutboundAttachments } from "../outbound-attachments.js";

import { createTeamsFileAuthority } from "./file-transfer-authority.js";

import type { EndpointRow, RuntimeContext } from "../runtime-types.js";

import { type ChatRuntime } from "../../chat-runtime.js";
import type { ChatEndpointRuntime } from "../../voice/voice-runtime.js";

import { chatCredentialMutationLease, type CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";

import {
  and,
  eq,
  inArray,
  lte,
  or,
} from "drizzle-orm";

import type { Db } from "@paperclipai/db";

import {
  chatPublications,
  chatTeamsFileTransfers,
} from "@paperclipai/db";

import {
  teamsFileTransferService,
  type TeamsFileTransferAuthority,
  type TeamsFileTransferOptions,
} from "../../chat-teams-file-transfers.js";
import { projectTeamsFilePublication } from "../../chat-teams-file-publication.js";
import type { TeamsFileConsentEvent } from "../../chat-teams-file-consent.js";

import {
  HttpError,
  conflict,
} from "../../../errors.js";
import { logger } from "../../../middleware/logger.js";

import {
  type ChatSdkCallbackEvent,
  type ChatSdkRuntime,
} from "../../chat-sdk-runtime.js";

import type { EndpointRecord } from "../runtime-types.js";

type TeamsFileDeliveryOptions = {
  endpointRecord: (endpointId: string) => Promise<EndpointRecord | null>;
  runtimeContextForRecord: (record: EndpointRecord) => RuntimeContext;
  runtimeFor: (endpoint: EndpointRow) => Promise<ChatEndpointRuntime>;
  runtimeContexts: Pick<WeakMap<object, RuntimeContext>, "get">;
  localRuntimeEpoch: (endpointId: string) => number;
  runtime: Pick<ChatSdkRuntime | ChatRuntime, "get">;
  deriveTeamsFileTransferAuthority: ReturnType<typeof createTeamsFileAuthority>["deriveTeamsFileTransferAuthority"];
  publicationFiles: ReturnType<typeof createOutboundAttachments>["publicationFiles"];
  teamsFileUploadRequest?: TeamsFileTransferOptions["uploadRequest"];
  scheduleMessageProcessing: (task: () => Promise<void>) => void;
  processPendingPublications: () => Promise<unknown>;
  withCredentialMutationLease: ReturnType<typeof chatCredentialMutationLease>;
  teamsFileRetryAfter: Map<string, number>;
  isShuttingDown: () => boolean;
};

export function createTeamsFileDelivery(db: Db, options: TeamsFileDeliveryOptions) {
  const { endpointRecord, runtimeContextForRecord, runtimeFor, runtimeContexts, localRuntimeEpoch, runtime, deriveTeamsFileTransferAuthority, publicationFiles, scheduleMessageProcessing, processPendingPublications, withCredentialMutationLease, teamsFileRetryAfter, isShuttingDown } = options;


  function teamsTransferProtocol(
    input: {
      credentialLease?: CredentialMutationLeaseGuard;
      callbackContext?: RuntimeContext;
    } = {},
  ) {
    const denied = () =>
      conflict("Teams file delivery authority changed", {
        code: "chat_file_transfer_authority_changed",
      });
    const currentRuntime = async (authority: TeamsFileTransferAuthority) => {
      if (!input.credentialLease) throw denied();
      await input.credentialLease.assertOwned();
      const record = await endpointRecord(authority.endpointId);
      if (
        !record ||
        record.endpoint.companyId !== authority.companyId ||
        record.endpoint.provider !== "microsoft-teams" ||
        record.endpoint.status !== "active"
      )
        throw denied();
      const context = runtimeContextForRecord(record);
      if (
        context.generation !== authority.runtimeGeneration ||
        context.credentialFingerprint !== authority.credentialFingerprint
      )
        throw denied();
      const instance = await runtimeFor(record.endpoint);
      const registered = runtimeContexts.get(instance as object);
      if (
        !registered ||
        registered.version !== context.version ||
        registered.localEpoch !== localRuntimeEpoch(authority.endpointId) ||
        runtime.get(authority.endpointId) !== instance
      )
        throw denied();
      await input.credentialLease.assertOwned();
      return instance;
    };
    const personalThread = (authority: TeamsFileTransferAuthority) =>
      `teams:${Buffer.from(authority.providerConversationId).toString("base64url")}:personal`;
    return teamsFileTransferService(db, {
      project: projectTeamsFilePublication,
      authorize: async (tx, expected, stage) => {
        await input.credentialLease?.assertOwned(tx);
        if (
          input.callbackContext &&
          (input.callbackContext.generation !== expected.runtimeGeneration ||
            input.callbackContext.credentialFingerprint !==
              expected.credentialFingerprint ||
            input.callbackContext.localEpoch !==
              localRuntimeEpoch(expected.endpointId) ||
            input.callbackContext.endpointRuntime !==
              runtime.get(expected.endpointId))
        )
          throw denied();
        const [publication] = await tx
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.companyId, expected.companyId),
              eq(chatPublications.endpointId, expected.endpointId),
              eq(chatPublications.id, expected.publicationId),
            ),
          )
          .for("update");
        // This selector is derived only inside the staged protocol's locked
        // authority check, never from a retry request or a model instruction.
        const [continuing] =
          publication?.state === "delivery_unknown" &&
          (stage === "response" || stage === "file_info")
            ? await tx
                .select({
                  transferId: chatTeamsFileTransfers.id,
                  publicationId: chatTeamsFileTransfers.publicationId,
                  version: chatTeamsFileTransfers.version,
                  phase: chatTeamsFileTransfers.phase,
                })
                .from(chatTeamsFileTransfers)
                .where(
                  and(
                    eq(chatTeamsFileTransfers.companyId, expected.companyId),
                    eq(chatTeamsFileTransfers.endpointId, expected.endpointId),
                    eq(
                      chatTeamsFileTransfers.conversationId,
                      expected.conversationId,
                    ),
                    eq(
                      chatTeamsFileTransfers.publicationId,
                      expected.publicationId,
                    ),
                    eq(
                      chatTeamsFileTransfers.phase,
                      stage === "response"
                        ? "consent_unknown"
                        : "file_info_unknown",
                    ),
                  ),
                )
                .for("update")
            : [];
        const current =
          publication &&
          (await deriveTeamsFileTransferAuthority(
            tx,
            publication,
            {
              generation: expected.runtimeGeneration,
              credentialFingerprint: expected.credentialFingerprint,
            },
            continuing && {
              ...continuing,
              phase: continuing.phase as
                | "consent_unknown"
                | "file_info_unknown",
            },
          ));
        if (!current) throw denied();
        await input.credentialLease?.assertOwned(tx);
        return current;
      },
      loadBytes: async (authority) => {
        const [publication] = await db
          .select()
          .from(chatPublications)
          .where(
            and(
              eq(chatPublications.companyId, authority.companyId),
              eq(chatPublications.endpointId, authority.endpointId),
              eq(chatPublications.id, authority.publicationId),
            ),
          );
        if (!publication) throw denied();
        const files = await publicationFiles(publication, publication.payload);
        if (files.length !== 1 || !Buffer.isBuffer(files[0]?.data))
          throw denied();
        return files[0].data;
      },
      postConsent: async ({ authority, card, signal }) => {
        const instance = await currentRuntime(authority);
        signal.throwIfAborted();
        return instance.sendTeamsFileConsentCard(
          personalThread(authority),
          card,
        );
      },
      postFileInfo: async ({ authority, card, signal }) => {
        const instance = await currentRuntime(authority);
        signal.throwIfAborted();
        return instance.sendTeamsUploadedFileCard(
          personalThread(authority),
          card,
        );
      },
      uploadRequest: options.teamsFileUploadRequest,
    });
  }

  async function handleTeamsFileConsent(
    callback: ChatSdkCallbackEvent<TeamsFileConsentEvent>,
    context: RuntimeContext,
  ): Promise<"recorded" | "ignored" | "denied"> {
    if (
      callback.provider !== "microsoft-teams" ||
      callback.endpointId !== callback.event.endpointId ||
      context.endpointRuntime !== runtime.get(callback.endpointId) ||
      context.localEpoch !== localRuntimeEpoch(callback.endpointId)
    )
      return "denied";
    // Do not wait for the sender's credential lease: an authentic acceptance
    // can arrive while its consent-card POST is still awaiting the receipt.
    let result: "recorded" | "ignored" | "denied";
    try {
      result = await teamsTransferProtocol({
        callbackContext: context,
      }).recordConsent(callback.event);
    } catch (error) {
      // A known current-policy denial is not a temporary provider outage.
      // Contention and unproven persistence still propagate as retryable 503.
      if (
        error instanceof HttpError &&
        (error.details as { code?: string } | undefined)?.code ===
          "chat_file_transfer_authority_changed"
      )
        return "denied";
      throw error;
    }
    if (result === "recorded")
      scheduleMessageProcessing(async () => {
        await processPendingPublications();
      });
    return result;
  }

  async function tryProcessTeamsFilePublication(
    selected: typeof chatPublications.$inferSelect,
  ): Promise<boolean> {
    const [existing] = await db
      .select({
        id: chatTeamsFileTransfers.id,
        endpointId: chatTeamsFileTransfers.endpointId,
        conversationId: chatTeamsFileTransfers.conversationId,
      })
      .from(chatTeamsFileTransfers)
      .where(
        and(
          eq(chatTeamsFileTransfers.companyId, selected.companyId),
          eq(chatTeamsFileTransfers.publicationId, selected.id),
        ),
      );
    if (!existing && !selected.payload.attachmentIds?.length) return false;
    const record = await endpointRecord(selected.endpointId);
    if (!record || record.endpoint.provider !== "microsoft-teams")
      return Boolean(existing);
    if (
      existing &&
      (existing.endpointId !== selected.endpointId ||
        existing.conversationId !== selected.conversationId)
    )
      return true;
    if (record.endpoint.status !== "active") return Boolean(existing);
    try {
      return await withCredentialMutationLease(
        record.endpoint,
        async (credentialLease) => {
          await runtimeFor(record.endpoint);
          const protocol = teamsTransferProtocol({ credentialLease });
          let transferId = existing?.id;
          if (!transferId) {
            const authority = await db.transaction(async (tx) => {
              await credentialLease.assertOwned(tx);
              const [current] = await tx
                .select()
                .from(chatPublications)
                .where(
                  and(
                    eq(chatPublications.companyId, selected.companyId),
                    eq(chatPublications.id, selected.id),
                  ),
                )
                .for("update");
              if (
                !current ||
                !["pending", "retry"].includes(current.state) ||
                (current.nextAttemptAt && current.nextAttemptAt > new Date())
              )
                return null;
              return deriveTeamsFileTransferAuthority(
                tx,
                current,
                runtimeContextForRecord(record),
              );
            });
            // Missing personal-recipient proof is not permission to guess a DM.
            // The ordinary path sends the truthful task-link fallback instead.
            if (!authority) return false;
            transferId = (
              await protocol.issue(
                authority,
                new Date(Date.now() + 60 * 60 * 1000),
              )
            ).id;
          }
          // A successful consent/upload transition can immediately progress to
          // its next effect, but no user wait, unknown outcome or backoff spins.
          for (let stage = 0; stage < 3; stage++) {
            const [current] = await db
              .select({ nextAttemptAt: chatPublications.nextAttemptAt })
              .from(chatPublications)
              .where(
                and(
                  eq(chatPublications.companyId, selected.companyId),
                  eq(chatPublications.id, selected.id),
                ),
              );
            if (
              !current ||
              (current.nextAttemptAt && current.nextAttemptAt > new Date())
            )
              break;
            const result = await protocol.process(
              selected.companyId,
              transferId,
            );
            if (
              ![
                "consent_pending",
                "upload_pending",
                "file_info_pending",
              ].includes(result.phase)
            )
              break;
          }
          teamsFileRetryAfter.delete(selected.id);
          return true;
        },
      );
    } catch {
      // A failed authorization/lock/receipt write must never fall through to a
      // generic resend. Preserve exact durable evidence; this cooldown grants
      // no authority and safely resets when the server restarts.
      if (teamsFileRetryAfter.size >= 1000)
        teamsFileRetryAfter.delete(teamsFileRetryAfter.keys().next().value!);
      teamsFileRetryAfter.set(selected.id, Date.now() + 30_000);
      return true;
    }
  }

  let teamsMaintenancePending = false;
  let teamsMaintenanceAfter = 0;
  function scheduleTeamsFileMaintenance() {
    if (
      teamsMaintenancePending ||
      Date.now() < teamsMaintenanceAfter ||
      isShuttingDown()
    )
      return;
    teamsMaintenancePending = true;
    teamsMaintenanceAfter = Date.now() + 30_000;
    scheduleMessageProcessing(async () => {
      try {
        const scopes = await db
          .selectDistinct({ companyId: chatTeamsFileTransfers.companyId })
          .from(chatTeamsFileTransfers)
          .where(
            or(
              and(
                inArray(chatTeamsFileTransfers.phase, [
                  "consent_pending",
                  "awaiting_consent",
                  "upload_pending",
                ]),
                lte(chatTeamsFileTransfers.expiresAt, new Date()),
              ),
              and(
                inArray(chatTeamsFileTransfers.phase, [
                  "consent_sending",
                  "uploading",
                  "file_info_sending",
                  "conflict",
                ]),
                lte(chatTeamsFileTransfers.attemptExpiresAt, new Date()),
              ),
            ),
          );
        const protocol = teamsTransferProtocol();
        // Separate from the ordinary message queue. Each company sweep bounds
        // its row count and lock waits and performs no provider I/O.
        for (const scope of scopes) {
          if (isShuttingDown()) break;
          await protocol.expireAndRecover(scope.companyId, 100);
        }
      } catch {
        // Selection errors are closed here too; private transfer envelopes and
        // SQL parameters must not escape through the generic background logger.
        logger.warn(
          "Teams file maintenance will retry after a temporary failure",
        );
      } finally {
        teamsMaintenancePending = false;
      }
    });
  }
  return { teamsTransferProtocol, handleTeamsFileConsent, tryProcessTeamsFilePublication, scheduleTeamsFileMaintenance };
}
