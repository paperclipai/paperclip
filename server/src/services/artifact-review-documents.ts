import { isDeepStrictEqual } from "node:util";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { assets, documentRevisions, documents, issueAttachments, issueDocuments } from "@paperclipai/db";
import {
  MARKDOWN_REVIEW_DOCUMENT_MAX_BYTES,
  artifactReviewDocumentKey,
  getAttachmentArtifactWorkProductMetadata,
  isMarkdownAttachmentContent,
  type AttachmentArtifactWorkProductMetadata,
  type IssueWorkProduct,
} from "@paperclipai/shared";
import {
  HttpError,
  conflict,
  notFound,
  payloadTooLarge,
  unprocessable,
  unsupportedMediaType,
} from "../errors.js";
import type { StorageService } from "../storage/types.js";
import { documentAnnotationService } from "./document-annotations.js";
import { documentService, issueDocumentSelect, mapIssueDocumentRow } from "./documents.js";

export type EnsureArtifactReviewWorkProduct = Pick<
  IssueWorkProduct,
  "id" | "companyId" | "issueId" | "type" | "provider" | "metadata" | "title" | "createdByRunId" | "sourceTrust"
>;

export interface EnsureArtifactReviewDocumentInput {
  issue: { id: string; companyId: string };
  workProduct: EnsureArtifactReviewWorkProduct;
}

type RemappedAnnotations = Awaited<
  ReturnType<ReturnType<typeof documentAnnotationService>["remapOpenThreadsForDocument"]>
>;

export interface EnsureArtifactReviewDocumentResult {
  document: ReturnType<typeof mapIssueDocumentRow> & { body?: string };
  created: boolean;
  revisionChanged: boolean;
  remappedAnnotations: RemappedAnnotations;
}

/**
 * Materializes the review IssueDocument for an eligible Markdown
 * attachment-backed work product under the deterministic
 * `artifact-review-<workProductId>` key. The operation is idempotent: repeated
 * calls return the existing document and only write a new revision when the
 * review content or its work-product provenance changed.
 */
export function artifactReviewDocumentService(db: Db, storage: StorageService) {
  const documentsSvc = documentService(db);
  const annotationsSvc = documentAnnotationService(db);

  const getExistingByKey = async (issueId: string, key: string) => {
    const document = await db
      .select(issueDocumentSelect)
      .from(issueDocuments)
      .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(issueDocuments.issueId, issueId), eq(issueDocuments.key, key)))
      .then((rows) => (rows[0] ? mapIssueDocumentRow(rows[0], true) : null));
    if (!document) return null;
    const latestRevision = document.latestRevisionId
      ? await db
        .select({
          createdByAgentId: documentRevisions.createdByAgentId,
          createdByUserId: documentRevisions.createdByUserId,
          createdByRunId: documentRevisions.createdByRunId,
        })
        .from(documentRevisions)
        .where(and(
          eq(documentRevisions.id, document.latestRevisionId),
          eq(documentRevisions.documentId, document.id),
          eq(documentRevisions.companyId, document.companyId),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    return { document, latestRevision };
  };

  const readMarkdownAttachmentBody = async (
    issue: { id: string; companyId: string },
    metadata: AttachmentArtifactWorkProductMetadata,
  ) => {
    const attachment = await db
      .select({
        id: issueAttachments.id,
        companyId: issueAttachments.companyId,
        issueId: issueAttachments.issueId,
        objectKey: assets.objectKey,
        contentType: assets.contentType,
        byteSize: assets.byteSize,
        originalFilename: assets.originalFilename,
        createdByAgentId: assets.createdByAgentId,
        createdByUserId: assets.createdByUserId,
      })
      .from(issueAttachments)
      .innerJoin(assets, eq(issueAttachments.assetId, assets.id))
      .where(eq(issueAttachments.id, metadata.attachmentId))
      .then((rows) => rows[0] ?? null);
    // Unknown and cross-scope attachment ids are deliberately
    // indistinguishable: canonical metadata must reference an attachment on
    // the same issue and company.
    if (!attachment || attachment.companyId !== issue.companyId || attachment.issueId !== issue.id) {
      throw unprocessable("Work product attachment must reference an attachment on the same issue", {
        code: "invalid_attachment_artifact_metadata",
        attachmentId: metadata.attachmentId,
      });
    }
    if (!isMarkdownAttachmentContent(attachment)) {
      throw unsupportedMediaType("Work product attachment is not Markdown", {
        code: "unsupported_review_document_content_type",
        contentType: attachment.contentType,
      });
    }
    if (attachment.byteSize > MARKDOWN_REVIEW_DOCUMENT_MAX_BYTES) {
      throw payloadTooLarge("Markdown attachment exceeds the review document size limit", {
        code: "review_document_too_large",
        byteSize: attachment.byteSize,
        maxBytes: MARKDOWN_REVIEW_DOCUMENT_MAX_BYTES,
      });
    }

    const object = await storage.getObject(attachment.companyId, attachment.objectKey);
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of object.stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      // Defense in depth: enforce the cap during streaming too, so a
      // metadata/object size mismatch can never exceed the limit.
      if (total > MARKDOWN_REVIEW_DOCUMENT_MAX_BYTES) {
        object.stream.destroy();
        throw payloadTooLarge("Markdown attachment exceeds the review document size limit", {
          code: "review_document_too_large",
          maxBytes: MARKDOWN_REVIEW_DOCUMENT_MAX_BYTES,
        });
      }
      chunks.push(buffer);
    }

    let body: string;
    try {
      body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    } catch {
      throw unprocessable("Markdown attachment is not valid UTF-8", {
        code: "invalid_review_document_encoding",
        attachmentId: attachment.id,
      });
    }
    return { attachment, body };
  };

  return {
    ensureForWorkProduct: async (
      input: EnsureArtifactReviewDocumentInput,
    ): Promise<EnsureArtifactReviewDocumentResult> => {
      const { issue, workProduct } = input;
      if (workProduct.issueId !== issue.id || workProduct.companyId !== issue.companyId) {
        throw notFound("Work product not found");
      }
      const metadata = getAttachmentArtifactWorkProductMetadata(workProduct);
      if (!metadata) {
        throw unprocessable("Work product is not an attachment-backed Paperclip artifact", {
          code: "not_attachment_backed_artifact",
          workProductId: workProduct.id,
        });
      }
      if (!isMarkdownAttachmentContent(metadata)) {
        throw unsupportedMediaType("Work product attachment is not Markdown", {
          code: "unsupported_review_document_content_type",
          contentType: metadata.contentType,
        });
      }

      const { attachment, body } = await readMarkdownAttachmentBody(issue, metadata);
      const key = artifactReviewDocumentKey(workProduct.id);
      // The review document represents agent-authored attachment content, so
      // attribution promotes the attachment/work-product provenance instead of
      // the actor who triggered materialization.
      const attribution = {
        createdByAgentId: attachment.createdByAgentId ?? null,
        createdByUserId: attachment.createdByUserId ?? null,
        createdByRunId: workProduct.createdByRunId ?? null,
        sourceTrust: workProduct.sourceTrust ?? null,
      };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const existingState = await getExistingByKey(issue.id, key);
        const existing = existingState?.document ?? null;
        const latestRevision = existingState?.latestRevision ?? null;
        const reviewStateMatches = existing &&
          existing.body === body &&
          existing.title === (workProduct.title ?? null) &&
          existing.format === "markdown" &&
          latestRevision?.createdByAgentId === attribution.createdByAgentId &&
          latestRevision.createdByUserId === attribution.createdByUserId &&
          latestRevision.createdByRunId === attribution.createdByRunId &&
          isDeepStrictEqual(existing.sourceTrust ?? null, attribution.sourceTrust);
        if (reviewStateMatches) {
          return { document: existing, created: false, revisionChanged: false, remappedAnnotations: [] };
        }
        try {
          const result = await documentsSvc.upsertIssueDocument({
            issueId: issue.id,
            key,
            title: workProduct.title ?? null,
            format: "markdown",
            body,
            changeSummary: existing
              ? "Synced from the work product attachment"
              : "Materialized from the Markdown work product attachment",
            baseRevisionId: existing?.latestRevisionId ?? null,
            ...attribution,
            lockedDocumentStrategy: "conflict",
          });
          const remappedAnnotations = result.created
            ? []
            : await annotationsSvc.remapOpenThreadsForDocument({
              issueId: issue.id,
              key: result.document.key,
              documentId: result.document.id,
              nextRevisionId: result.document.latestRevisionId,
              nextRevisionNumber: result.document.latestRevisionNumber,
              nextBody: result.document.body,
            });
          return {
            document: result.document,
            created: result.created,
            revisionChanged: true,
            remappedAnnotations,
          };
        } catch (error) {
          // A concurrent materialization or document write raced this one.
          // Re-read once so identical content converges on the winner.
          if (error instanceof HttpError && error.status === 409 && attempt === 0) continue;
          throw error;
        }
      }
      throw conflict("Concurrent review-document updates did not converge", { key });
    },
  };
}
