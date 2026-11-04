import type { chatPublications } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { chatTeamsFileTransfers } from "@paperclipai/db";
import { conflict } from "../../../errors.js";
import { logActivity } from "../../activity-log.js";
import type { DbTransaction } from "../runtime-types.js";
import type { CredentialMutationLeaseGuard } from "../../chat-credential-mutation-lease.js";
import type { createTeamsFileDelivery } from "./file-delivery.js";
import type { ChatFileTransferPhase } from "@paperclipai/shared";
type FileResolutionInput = { endpointId: string; publication: typeof chatPublications.$inferSelect; action: "mark_delivered" | "retry_anyway" | "cancel"; userId: string; credentialLease: CredentialMutationLeaseGuard; fileTransfer?: { phase: ChatFileTransferPhase; version: number } };
export async function resolveTeamsFilePublication(tx: DbTransaction, input: FileResolutionInput, teamsTransferProtocol: ReturnType<typeof createTeamsFileDelivery>["teamsTransferProtocol"]): Promise<boolean> {
  const { endpointId, publication, action, userId, credentialLease, fileTransfer } = input;
  const transfer = await tx
    .select({
      id: chatTeamsFileTransfers.id,
      endpointId: chatTeamsFileTransfers.endpointId,
      conversationId: chatTeamsFileTransfers.conversationId,
      phase: chatTeamsFileTransfers.phase,
      version: chatTeamsFileTransfers.version,
    })
    .from(chatTeamsFileTransfers)
    .where(
      and(
        eq(chatTeamsFileTransfers.companyId, publication.companyId),
        eq(chatTeamsFileTransfers.publicationId, publication.id),
      ),
    )
    .then((rows) => rows[0]);
  if (transfer || fileTransfer) {
    const resolutionRequired = () =>
      conflict(
        "File delivery requires its current stage-specific resolution",
        { code: "chat_file_transfer_resolution_required" },
      );
    if (
      !transfer ||
      !fileTransfer ||
      publication.state !== "delivery_unknown" ||
      transfer.endpointId !== publication.endpointId ||
      transfer.conversationId !== publication.conversationId ||
      transfer.phase !== fileTransfer.phase ||
      transfer.version !== fileTransfer.version ||
      ![
        "consent_unknown",
        "upload_unknown",
        "file_info_unknown",
        "conflict",
      ].includes(transfer.phase)
    )
      throw resolutionRequired();
    let result;
    try {
      result = await teamsTransferProtocol({
        credentialLease,
      }).resolveInTransaction(tx, {
        companyId: publication.companyId,
        publicationId: publication.id,
        transferId: transfer.id,
        expectedVersion: fileTransfer.version,
        expectedPhase: fileTransfer.phase as
          | "consent_unknown"
          | "upload_unknown"
          | "file_info_unknown"
          | "conflict",
        action,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
        "Teams file transfer authority or state changed"
      )
        throw resolutionRequired();
      throw error;
    }
    await logActivity(tx as unknown as Db, {
      companyId: publication.companyId,
      actorType: "user",
      actorId: userId,
      action: `chat.publication_${action}`,
      entityType: "chat_publication",
      entityId: publication.id,
      issueId: publication.issueId,
      details: {
        endpointId,
        conversationId: publication.conversationId,
        transferId: transfer.id,
        previousPhase: fileTransfer.phase,
        previousVersion: fileTransfer.version,
        nextPhase: result.phase,
        nextVersion: result.version,
        duplicateRiskAcknowledged: action === "retry_anyway",
      },
    });
    await credentialLease.assertOwned(tx);
    return true;
  }
  return false;
}
