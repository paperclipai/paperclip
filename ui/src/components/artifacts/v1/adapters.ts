import type { IssueAttachment, IssueDocument, IssueDocumentSummary, IssueWorkProduct } from "@paperclipai/shared";
import type { AttachmentRef } from "@/components/task-chat/task-chat-attachments";
import { getAttachmentArtifactWorkProductMetadata } from "@paperclipai/shared";
import { artifactUrl } from "@/lib/artifact-card-data";
import { documentDisplayTitle, workProductHref } from "@/lib/issue-artifacts";
import { attachmentDownloadPath, attachmentOpenPath } from "@/lib/issue-attachments";
import { extOf, kindFor, type ArtifactSubject } from "./kinds";
import { sizeLabel } from "./when";

/**
 * The panel's and the thread's payloads as the artwork sees them. Dates come
 * as Date objects from the types and as strings over the wire; both are
 * normalised to ISO strings.
 */
const iso = (value: Date | string) => new Date(value).toISOString();

const text = (metadata: Record<string, unknown> | null, key: string): string | null => {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
};
const num = (metadata: Record<string, unknown> | null, key: string): number | null => {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/** A task document: the sheet with its title set on it when it has text, named after its key. */
export function subjectFromIssueDocument(doc: IssueDocument): ArtifactSubject {
  return {
    kind: "document",
    title: documentDisplayTitle(doc),
    filename: `${doc.key}.md`,
    ext: "md",
    contentType: "text/markdown",
    hasText: doc.body.trim().length > 0,
    isTaskDocument: true,
    updatedAt: iso(doc.updatedAt),
  };
}

/** An attached file: named after its original file name, sized, with the picture when it is one. */
export function subjectFromAttachment(attachment: IssueAttachment): ArtifactSubject {
  const filename = attachment.originalFilename ?? attachment.objectKey;
  const ext = extOf({ filename });
  const kind = kindFor(ext, attachment.contentType);
  const source = kind === "image" || kind === "video" ? artifactUrl(attachment.contentPath) || null : null;
  return {
    kind,
    title: filename,
    filename,
    ext,
    contentType: attachment.contentType,
    thumbnailUrl: kind === "image" ? source : null,
    videoUrl: kind === "video" ? source : null,
    sizeLabel: sizeLabel(attachment.byteSize),
    updatedAt: iso(attachment.updatedAt),
  };
}

/**
 * A work product: an attachment-backed artifact reads like the file it wraps;
 * any other kind (a pull request, a commit, a preview URL, a branch, a
 * service) is a link named by its title.
 */
export function subjectFromWorkProduct(workProduct: IssueWorkProduct): ArtifactSubject {
  const attachment = getAttachmentArtifactWorkProductMetadata(workProduct);
  const metadata = workProduct.metadata;
  const updatedAt = iso(workProduct.updatedAt);
  if (attachment || workProduct.type === "artifact") {
    const filename = attachment?.originalFilename ?? text(metadata, "originalFilename") ?? workProduct.title;
    const contentType = attachment?.contentType ?? text(metadata, "contentType");
    const contentPath = artifactUrl(attachment?.contentPath ?? text(metadata, "contentPath") ?? workProductHref(workProduct));
    const ext = extOf({ filename });
    const kind = kindFor(ext, contentType);
    const source = (kind === "image" || kind === "video") && contentPath ? contentPath : null;
    return {
      kind,
      title: workProduct.title,
      filename,
      ext,
      contentType,
      thumbnailUrl: kind === "image" ? source : null,
      videoUrl: kind === "video" ? source : null,
      sizeLabel: sizeLabel(attachment?.byteSize ?? num(metadata, "byteSize") ?? num(metadata, "size")),
      updatedAt,
    };
  }
  return { kind: "link", title: workProduct.title, updatedAt };
}

/** A document named in the thread (a summary: no body), as a row. */
export function subjectFromDocumentSummary(doc: IssueDocumentSummary): ArtifactSubject {
  return {
    kind: "document",
    title: documentDisplayTitle(doc),
    filename: `${doc.key}.md`,
    ext: "md",
    contentType: "text/markdown",
    isTaskDocument: true,
    updatedAt: doc.updatedAt ? iso(doc.updatedAt) : null,
  };
}

/** A file a message refers to (`[name](/api/attachments/…/content)` or a bound upload); it carries no date of its own. */
export function subjectFromAttachmentRef(ref: AttachmentRef): ArtifactSubject {
  const ext = extOf({ filename: ref.name });
  const kind = kindFor(ext, ref.contentType);
  const source = kind === "image" || kind === "video" ? artifactUrl(ref.openPath ?? ref.url) || null : null;
  return {
    kind,
    title: ref.name,
    filename: ref.name,
    ext,
    contentType: ref.contentType ?? null,
    thumbnailUrl: kind === "image" ? source : null,
    videoUrl: kind === "video" ? source : null,
    sizeLabel: sizeLabel(ref.byteSize ?? null),
  };
}

/** What a file row needs to open and offer a file the way the shipped card does. */
export interface FileRowSource {
  id: string;
  attachmentId?: string;
  filename: string;
  contentType: string;
  contentPath: string;
  openPath: string;
  downloadPath: string;
  byteSize: number | null;
}

/** An attached file's paths. */
export function fileRowSourceFromAttachment(attachment: IssueAttachment): FileRowSource {
  const filename = attachment.originalFilename ?? attachment.objectKey;
  return {
    id: attachment.id,
    attachmentId: attachment.id,
    filename,
    contentType: attachment.contentType,
    contentPath: artifactUrl(attachment.contentPath),
    openPath: artifactUrl(attachmentOpenPath(attachment)),
    downloadPath: artifactUrl(attachmentDownloadPath(attachment)),
    byteSize: attachment.byteSize,
  };
}

/** A registered file's paths, or null when the work product is not a file (a pull request, a service, …). */
export function fileRowSourceFromWorkProduct(workProduct: IssueWorkProduct): FileRowSource | null {
  if (workProduct.type !== "artifact") return null;
  const attachment = getAttachmentArtifactWorkProductMetadata(workProduct);
  const metadata = workProduct.metadata;
  const contentPath = artifactUrl(attachment?.contentPath ?? text(metadata, "contentPath") ?? workProductHref(workProduct));
  if (!attachment && !contentPath) return null;
  return {
    id: workProduct.id,
    attachmentId: attachment?.attachmentId,
    filename: attachment?.originalFilename ?? text(metadata, "originalFilename") ?? workProduct.title,
    contentType: attachment?.contentType ?? text(metadata, "contentType") ?? "",
    contentPath,
    openPath: artifactUrl(attachment?.openPath ?? text(metadata, "openPath")) || contentPath,
    downloadPath: artifactUrl(attachment?.downloadPath ?? text(metadata, "downloadPath")) || attachmentDownloadPath({ contentPath }),
    byteSize: attachment?.byteSize ?? num(metadata, "byteSize") ?? num(metadata, "size"),
  };
}
