import type {
  AttachmentArtifactWorkProductMetadata,
  IssueWorkProduct,
} from "./types/work-product.js";
import { attachmentArtifactWorkProductMetadataSchema } from "./validators/work-product.js";

/**
 * Shared classification for bridging attachment-backed Markdown work products
 * into the issue document review experience. Server materialization and UI
 * presentation must agree on eligibility, so both sides use these helpers.
 */

export const MARKDOWN_ATTACHMENT_CONTENT_TYPES = [
  "text/markdown",
  "text/x-markdown",
  "application/markdown",
  "application/x-markdown",
] as const;

const MARKDOWN_ATTACHMENT_CONTENT_TYPE_SET = new Set<string>(MARKDOWN_ATTACHMENT_CONTENT_TYPES);

const MARKDOWN_FALLBACK_CONTENT_TYPES = new Set([
  "text/plain",
  "application/octet-stream",
  "binary/octet-stream",
  "application/x-binary",
]);

const MARKDOWN_FILENAME_EXTENSIONS = [".md", ".markdown"];

/**
 * Maximum attachment size eligible for review-document materialization.
 * Matches the issue-document body limit: a UTF-8 payload of at most this many
 * bytes always fits the 524288-character body cap.
 */
export const MARKDOWN_REVIEW_DOCUMENT_MAX_BYTES = 512 * 1024;

export const ARTIFACT_REVIEW_DOCUMENT_KEY_PREFIX = "artifact-review-";

function normalizeAttachmentContentType(contentType: string | null | undefined): string {
  return (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
}

export function isMarkdownAttachmentContent(input: {
  contentType: string | null | undefined;
  originalFilename?: string | null;
}): boolean {
  const contentType = normalizeAttachmentContentType(input.contentType);
  if (MARKDOWN_ATTACHMENT_CONTENT_TYPE_SET.has(contentType)) return true;
  const filename = (input.originalFilename ?? "").toLowerCase();
  if (!MARKDOWN_FILENAME_EXTENSIONS.some((extension) => filename.endsWith(extension))) {
    return false;
  }
  return MARKDOWN_FALLBACK_CONTENT_TYPES.has(contentType);
}

export type AttachmentArtifactWorkProductLike = Pick<
  IssueWorkProduct,
  "type" | "provider" | "metadata"
>;

export function getAttachmentArtifactWorkProductMetadata(
  workProduct: AttachmentArtifactWorkProductLike,
): AttachmentArtifactWorkProductMetadata | null {
  if (workProduct.type !== "artifact" || workProduct.provider !== "paperclip") return null;
  if (!workProduct.metadata) return null;
  const parsed = attachmentArtifactWorkProductMetadataSchema.safeParse(workProduct.metadata);
  return parsed.success ? parsed.data : null;
}

export function getMarkdownWorkProductAttachmentMetadata(
  workProduct: AttachmentArtifactWorkProductLike,
): AttachmentArtifactWorkProductMetadata | null {
  const metadata = getAttachmentArtifactWorkProductMetadata(workProduct);
  if (!metadata) return null;
  return isMarkdownAttachmentContent(metadata) ? metadata : null;
}

export function isMarkdownArtifactWorkProduct(
  workProduct: AttachmentArtifactWorkProductLike,
): boolean {
  return getMarkdownWorkProductAttachmentMetadata(workProduct) !== null;
}

export function artifactReviewDocumentKey(workProductId: string): string {
  return `${ARTIFACT_REVIEW_DOCUMENT_KEY_PREFIX}${workProductId}`;
}

export function isArtifactReviewDocumentKey(key: string): boolean {
  return (
    key.startsWith(ARTIFACT_REVIEW_DOCUMENT_KEY_PREFIX) &&
    key.length > ARTIFACT_REVIEW_DOCUMENT_KEY_PREFIX.length
  );
}

export function workProductIdFromArtifactReviewDocumentKey(key: string): string | null {
  if (!isArtifactReviewDocumentKey(key)) return null;
  return key.slice(ARTIFACT_REVIEW_DOCUMENT_KEY_PREFIX.length);
}
