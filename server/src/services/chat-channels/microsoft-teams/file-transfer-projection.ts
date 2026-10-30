import { sql } from "drizzle-orm";
import { chatTeamsFileTransfers } from "@paperclipai/db";

export const fileTransferProjectionColumns = {
  publicationId: chatTeamsFileTransfers.publicationId,
  phase: chatTeamsFileTransfers.phase,
  version: chatTeamsFileTransfers.version,
  filename: chatTeamsFileTransfers.filename,
  expiresAt: chatTeamsFileTransfers.expiresAt,
  consentMessageId: chatTeamsFileTransfers.consentMessageId,
  responseActivityId: chatTeamsFileTransfers.responseActivityId,
  fileInfoMessageId: chatTeamsFileTransfers.fileInfoMessageId,
  operatorConfirmed: sql<boolean>`
    coalesce(${chatTeamsFileTransfers.privateState}#>>'{resolution,schema}', '') = 'paperclip.teams.file-resolution.v1'
    and coalesce(${chatTeamsFileTransfers.privateState}#>>'{resolution,action}', '') = 'mark_delivered'
    and coalesce(${chatTeamsFileTransfers.privateState}#>>'{resolution,fromPhase}', '') = 'file_info_unknown'
  `,
};
