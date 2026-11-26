import type { IssueDocument, IssueWorkProduct } from "@paperclipai/shared";
import type { CompanyArtifact, CompanyArtifactGroup } from "@/api/artifacts";
import type { AttachmentRef } from "@/components/task-chat/task-chat-attachments";
import type { LabArtifact, LabGroup } from "../../kit";
import { COMPANY } from "../../fixtures";

/**
 * Lab fixtures → the product's own types, so the shipped components can be fed
 * unchanged. Each mapping mirrors what the server would have produced for the
 * same artifact; where it has to deviate, the comment says why.
 */

/** A stable 8-4-4-4-12 id; the attachment metadata schema insists on one. */
export function guid(seed: string): string {
  let h = 0x811c9dc5;
  let hex = "";
  for (let round = 0; hex.length < 32; round += 1) {
    for (const char of `${seed}:${round}`) h = Math.imul(h ^ char.charCodeAt(0), 0x01000193);
    hex += (h >>> 0).toString(16).padStart(8, "0");
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const agentId = (name: string) => guid(`agent:${name}`);
export const issueIdFor = (taskIdentifier: string) => guid(`issue:${taskIdentifier}`);

/** A task document, as opposed to a Markdown file an agent attached. */
export const isTaskDocument = (a: LabArtifact) => a.kind === "document" && a.revision != null;

const documentKey = (a: LabArtifact) => (a.filename ?? a.id).replace(/\.md$/, "");

/**
 * Media points at the bundled asset so the real `<img>` / `<video>` loads it.
 * That path is not the canonical attachment route, so for media the product's
 * attachment-metadata parser declines the record — which only switches off
 * "Open in tab", an action media never offers.
 */
function attachmentPaths(a: LabArtifact) {
  const attachmentId = guid(`attachment:${a.id}`);
  const canonical = `/api/attachments/${attachmentId}/content`;
  const media = a.kind === "image" ? a.thumbnailUrl : a.kind === "video" ? a.videoUrl : undefined;
  const contentPath = media ?? canonical;
  return { attachmentId, contentPath, openPath: contentPath, downloadPath: `${canonical}?download=1` };
}

export function toWorkProduct(a: LabArtifact, createdAt: Date = new Date(a.updatedAt)): IssueWorkProduct {
  const base = {
    id: guid(`work-product:${a.id}`),
    companyId: COMPANY.id,
    projectId: null,
    issueId: issueIdFor(a.taskIdentifier),
    executionWorkspaceId: null,
    runtimeServiceId: null,
    externalId: null,
    title: a.title,
    status: a.review === "needs_review" ? "ready_for_review" : a.review === "changes_requested" ? "changes_requested" : "approved",
    reviewState: a.review === "needs_review" ? "needs_board_review" : a.review === "changes_requested" ? "changes_requested" : "none",
    isPrimary: false,
    healthStatus: "unknown",
    summary: a.summary ?? null,
    createdByRunId: a.run?.id ?? null,
    createdAt,
    updatedAt: new Date(a.updatedAt),
  } satisfies Partial<IssueWorkProduct>;

  if (a.kind === "link") {
    // No `imageUrl`: the link card only loads thumbnails from the attachment
    // route, which the lab does not serve.
    return { ...base, type: "preview_url", provider: "custom", url: a.url ?? null, metadata: null };
  }
  return {
    ...base,
    type: "artifact",
    provider: "paperclip",
    url: null,
    metadata: {
      ...attachmentPaths(a),
      contentType: a.contentType ?? "application/octet-stream",
      byteSize: a.byteSize ?? 0,
      originalFilename: a.filename ?? a.title,
      ...(a.durationLabel ? { durationLabel: a.durationLabel } : {}),
    },
  };
}

export function toIssueDocument(a: LabArtifact, createdAt: Date = new Date(a.updatedAt)): IssueDocument {
  const author = agentId(a.author);
  return {
    id: guid(`document:${a.id}`),
    companyId: COMPANY.id,
    issueId: issueIdFor(a.taskIdentifier),
    key: documentKey(a),
    title: a.title,
    format: "markdown",
    latestRevisionId: guid(`revision:${a.id}`),
    latestRevisionNumber: a.revision ?? 1,
    createdByAgentId: author,
    createdByUserId: null,
    updatedByAgentId: author,
    updatedByUserId: null,
    lockedAt: null,
    lockedByAgentId: null,
    lockedByUserId: null,
    createdAt,
    updatedAt: new Date(a.updatedAt),
    body: a.body ?? a.excerpt ?? "",
  };
}

/** Thread href for a task document, as `buildDocumentAnnotationHash` writes it. */
export const documentHref = (a: LabArtifact) => `#document-${documentKey(a)}`;

export function toAttachmentRef(a: LabArtifact): AttachmentRef {
  const paths = attachmentPaths(a);
  return {
    id: paths.attachmentId,
    name: a.filename ?? a.title,
    url: paths.contentPath,
    openPath: paths.openPath,
    downloadPath: paths.downloadPath,
    contentType: a.contentType,
    byteSize: a.byteSize ?? undefined,
  };
}

/** `normalizePreviewText` (server/src/services/company-artifacts.ts:89-103): one run-on line, 280 chars. */
function previewText(text: string | undefined): string | null {
  if (!text) return null;
  const flat = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_\-~|`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > 280 ? `${flat.slice(0, 277).trimEnd()}...` : flat;
}

/**
 * `classifyMediaKind` (company-artifacts.ts:105-121). "document" means a task
 * document only; PDFs, decks, sheets and archives are all "file".
 */
function mediaKind(a: LabArtifact): CompanyArtifact["mediaKind"] {
  if (isTaskDocument(a)) return "document";
  const type = a.contentType ?? "";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return a.kind === "link" ? "empty" : "file";
}

export function toCompanyArtifact(a: LabArtifact): CompanyArtifact {
  const issue = { id: issueIdFor(a.taskIdentifier), identifier: a.taskIdentifier, title: a.taskTitle };
  const base = {
    title: a.title,
    issue,
    project: null,
    createdByAgent: { id: agentId(a.author), name: a.author },
    updatedAt: a.updatedAt,
  };
  if (isTaskDocument(a)) {
    return {
      ...base,
      id: guid(`document:${a.id}`),
      source: "document",
      mediaKind: "document",
      previewText: previewText(a.body ?? a.excerpt),
      contentType: "text/markdown",
      contentPath: null,
      openPath: null,
      downloadPath: null,
      href: `/${COMPANY.issuePrefix}/issues/${a.taskIdentifier}${documentHref(a)}`,
    };
  }
  const paths = a.kind === "link" ? null : attachmentPaths(a);
  return {
    ...base,
    id: guid(`work-product:${a.id}`),
    source: "work_product",
    mediaKind: mediaKind(a),
    // The server previews a work product by its summary, not its content.
    previewText: previewText(a.summary),
    contentType: a.contentType ?? null,
    contentPath: paths?.contentPath ?? null,
    openPath: paths?.openPath ?? null,
    downloadPath: paths?.downloadPath ?? null,
    href: `/${COMPANY.issuePrefix}/issues/${a.taskIdentifier}#work-product-${guid(`work-product:${a.id}`)}`,
  };
}

export function toCompanyArtifactGroup(g: LabGroup): CompanyArtifactGroup {
  const artifacts = g.artifacts.map(toCompanyArtifact);
  return {
    id: g.id,
    groupBy: "task",
    issue: { id: issueIdFor(g.taskIdentifier), identifier: g.taskIdentifier, title: g.title },
    title: g.title,
    count: g.count,
    mediaKinds: [...new Set(artifacts.map((a) => a.mediaKind))],
    previewArtifacts: artifacts.slice(0, 3),
    updatedAt: g.artifacts[0]?.updatedAt ?? new Date(0).toISOString(),
    href: `/${COMPANY.issuePrefix}/artifacts?groupIssueId=${issueIdFor(g.taskIdentifier)}`,
  };
}
