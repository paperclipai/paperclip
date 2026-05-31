import type { Db } from "@paperclipai/db";
import { issueService } from "./issues.js";

export type ResolvedIssueAttachmentForUpload = {
  attachmentId: string;
  href: string;
  label: string;
  objectKey: string;
  contentType: string | null;
  byteSize: number | null;
  sha256: string | null;
};

export async function resolveMostRecentIssueAttachmentForUpload(
  db: Db,
  input: { companyId: string; issueId: string },
): Promise<ResolvedIssueAttachmentForUpload | null> {
  const attachments = (await issueService(db).listAttachments(input.issueId))
    .filter((row) => row.companyId === input.companyId);
  const attachment = attachments[0] ?? null;
  if (!attachment) return null;

  return {
    attachmentId: attachment.id,
    href: `/api/attachments/${attachment.id}/content`,
    label: attachment.originalFilename?.trim() || attachment.id,
    objectKey: attachment.objectKey,
    contentType: attachment.contentType,
    byteSize: attachment.byteSize,
    sha256: attachment.sha256,
  };
}
