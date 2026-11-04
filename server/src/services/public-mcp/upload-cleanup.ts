import { and, eq } from "drizzle-orm";
import { mcpAttachmentUploads, type Db } from "@paperclipai/db";
import type { StorageService } from "../../storage/types.js";

type AttachmentStorage = {
  id: string;
  companyId: string;
  issueId: string;
  provider: string;
  objectKey: string;
};

export type McpAttachmentCleanup = AttachmentStorage & { verifiedAt: Date };

function uploadIdentity(attachment: AttachmentStorage) {
  return and(eq(mcpAttachmentUploads.companyId, attachment.companyId),
    eq(mcpAttachmentUploads.taskId, attachment.issueId), eq(mcpAttachmentUploads.attachmentId, attachment.id),
    eq(mcpAttachmentUploads.storageProvider, attachment.provider), eq(mcpAttachmentUploads.objectKey, attachment.objectKey));
}

/** Called after deletion by the attachment owner. A resolved delete alone can
 * be optimistic; only the exact upload's storage absence authorizes cleanup. */
export async function confirmMcpAttachmentCleanup(db: Db, storage: StorageService, attachment: AttachmentStorage): Promise<McpAttachmentCleanup | null> {
  const [upload] = await db.select({ id: mcpAttachmentUploads.id }).from(mcpAttachmentUploads).where(uploadIdentity(attachment)).limit(1);
  if (!upload) return null;
  if (storage.provider !== attachment.provider || (await storage.headObject(attachment.companyId, attachment.objectKey)).exists !== false) {
    throw new Error("MCP attachment storage cleanup could not be confirmed");
  }
  return { ...attachment, verifiedAt: new Date() };
}

/** Keep attachmentId as immutable replay identity. For attachment removal this
 * runs in the metadata deletion transaction; issue removal stamps each object
 * after its existing post-transaction storage cleanup completes. */
export async function recordMcpAttachmentCleanup(db: Pick<Db, "update">, cleanup: McpAttachmentCleanup | null | undefined) {
  if (!cleanup) return;
  await db.update(mcpAttachmentUploads).set({ cleanedAt: cleanup.verifiedAt, cleanupVerifiedAt: cleanup.verifiedAt }).where(uploadIdentity(cleanup));
}
