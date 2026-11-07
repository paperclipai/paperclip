/**
 * Attachment-chip helpers for the task-chat redesign (PAP-351): map a filename
 * to a kind icon + label for the shadcn base/attachment chips, and extract the
 * non-image file references the composer writes into message bodies
 * ("[name](/api/attachments/<id>/content)") so posted bubbles can render them
 * as the same chips instead of bare links.
 */
import {
  FileArchive,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  File as FileIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { IssueAttachment } from "@paperclipai/shared";
import { t } from "@/i18n";

export interface FileKind {
  icon: LucideIcon;
  /** Short kind label for the chip description, e.g. "PDF", "ZIP". */
  label: string;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "avif",
  "bmp",
  "ico",
  "heic",
]);

const KIND_BY_EXTENSION: Record<string, { icon: LucideIcon; labelKey: string }> = {
  pdf: { icon: FileText, labelKey: "common.fileKind.pdf" },
  doc: { icon: FileText, labelKey: "common.fileKind.doc" },
  docx: { icon: FileText, labelKey: "common.fileKind.doc" },
  txt: { icon: FileText, labelKey: "common.fileKind.text" },
  md: { icon: FileText, labelKey: "common.fileKind.markdown" },
  rtf: { icon: FileText, labelKey: "common.fileKind.text" },
  csv: { icon: FileSpreadsheet, labelKey: "common.fileKind.csv" },
  tsv: { icon: FileSpreadsheet, labelKey: "common.fileKind.tsv" },
  xls: { icon: FileSpreadsheet, labelKey: "common.fileKind.sheet" },
  xlsx: { icon: FileSpreadsheet, labelKey: "common.fileKind.sheet" },
  zip: { icon: FileArchive, labelKey: "common.fileKind.zip" },
  gz: { icon: FileArchive, labelKey: "common.fileKind.archive" },
  tar: { icon: FileArchive, labelKey: "common.fileKind.archive" },
  tgz: { icon: FileArchive, labelKey: "common.fileKind.archive" },
  rar: { icon: FileArchive, labelKey: "common.fileKind.archive" },
  "7z": { icon: FileArchive, labelKey: "common.fileKind.archive" },
  mp3: { icon: FileAudio, labelKey: "common.fileKind.audio" },
  wav: { icon: FileAudio, labelKey: "common.fileKind.audio" },
  m4a: { icon: FileAudio, labelKey: "common.fileKind.audio" },
  ogg: { icon: FileAudio, labelKey: "common.fileKind.audio" },
  mp4: { icon: FileVideo, labelKey: "common.fileKind.video" },
  mov: { icon: FileVideo, labelKey: "common.fileKind.video" },
  webm: { icon: FileVideo, labelKey: "common.fileKind.video" },
  json: { icon: FileCode, labelKey: "common.fileKind.json" },
  yaml: { icon: FileCode, labelKey: "common.fileKind.yaml" },
  yml: { icon: FileCode, labelKey: "common.fileKind.yaml" },
  xml: { icon: FileCode, labelKey: "common.fileKind.xml" },
  html: { icon: FileCode, labelKey: "common.fileKind.html" },
  css: { icon: FileCode, labelKey: "common.fileKind.css" },
  js: { icon: FileCode, labelKey: "common.fileKind.code" },
  jsx: { icon: FileCode, labelKey: "common.fileKind.code" },
  ts: { icon: FileCode, labelKey: "common.fileKind.code" },
  tsx: { icon: FileCode, labelKey: "common.fileKind.code" },
  py: { icon: FileCode, labelKey: "common.fileKind.code" },
  rb: { icon: FileCode, labelKey: "common.fileKind.code" },
  go: { icon: FileCode, labelKey: "common.fileKind.code" },
  rs: { icon: FileCode, labelKey: "common.fileKind.code" },
  sh: { icon: FileCode, labelKey: "common.fileKind.code" },
  sql: { icon: FileCode, labelKey: "common.fileKind.sql" },
  log: { icon: FileText, labelKey: "common.fileKind.log" },
  patch: { icon: FileCode, labelKey: "common.fileKind.patch" },
  diff: { icon: FileCode, labelKey: "common.fileKind.patch" },
};

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : "";
}

export function isImageFilename(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

type AttachmentRecord = Pick<
  IssueAttachment,
  | "id"
  | "contentPath"
  | "openPath"
  | "downloadPath"
  | "contentType"
  | "byteSize"
  | "originalFilename"
>;

function normalizedContentType(contentType: string | undefined): string {
  return (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
}

/** MIME type is authoritative; filenames remain a fallback for legacy refs. */
export function isImageAttachment(ref: AttachmentRef): boolean {
  const contentType = normalizedContentType(ref.contentType);
  if (contentType.startsWith("image/")) return true;
  if (contentType && contentType !== "application/octet-stream") return false;
  return isImageFilename(ref.name) || isImageFilename(ref.url.split("?")[0]);
}

/** Kind icon + short label for a filename; unknown extensions get File/"File". */
export function fileKindForName(name: string): FileKind {
  const kind = KIND_BY_EXTENSION[extensionOf(name)] ?? { icon: FileIcon, labelKey: "common.fileKind.file" };
  return { icon: kind.icon, label: t(kind.labelKey) };
}

export function fileKindForAttachment(ref: AttachmentRef): FileKind {
  if (KIND_BY_EXTENSION[extensionOf(ref.name)]) return fileKindForName(ref.name);

  const contentType = normalizedContentType(ref.contentType);
  if (contentType === "application/pdf") return { icon: FileText, label: t("common.fileKind.pdf") };
  if (contentType === "application/json" || contentType.endsWith("+json")) {
    return { icon: FileCode, label: t("common.fileKind.json") };
  }
  if (contentType === "text/csv" || contentType === "application/csv") {
    return { icon: FileSpreadsheet, label: t("common.fileKind.csv") };
  }
  if (contentType.startsWith("text/")) return { icon: FileText, label: t("common.fileKind.text") };
  if (contentType.startsWith("audio/")) return { icon: FileAudio, label: t("common.fileKind.audio") };
  if (contentType.startsWith("video/")) return { icon: FileVideo, label: t("common.fileKind.video") };
  if (contentType.includes("zip") || contentType.includes("archive")) {
    return { icon: FileArchive, label: t("common.fileKind.archive") };
  }
  return fileKindForName(ref.name);
}

/** "2.4 MB"-style size for chip descriptions (same tiers as IssueChatThread). */
export function formatFileSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentRef {
  name: string;
  url: string;
  id?: string;
  contentType?: string;
  byteSize?: number;
  openPath?: string;
  downloadPath?: string;
}

function attachmentIdFromUrl(url: string): string | null {
  return /\/api\/(?:attachments|assets)\/([^/?]+)\/content/.exec(url)?.[1] ?? null;
}

export function hydrateAttachmentRefs(
  refs: AttachmentRef[],
  attachments: AttachmentRecord[],
): AttachmentRef[] {
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const byPath = new Map(
    attachments.flatMap((attachment) => [
      [attachment.contentPath, attachment] as const,
      ...(attachment.openPath ? [[attachment.openPath, attachment] as const] : []),
    ]),
  );

  return refs.map((ref) => {
    const cleanUrl = ref.url.split("?")[0];
    const record =
      byPath.get(cleanUrl) ??
      byId.get(attachmentIdFromUrl(ref.url) ?? "");
    if (!record) return ref;
    return {
      ...ref,
      id: record.id,
      name: record.originalFilename?.trim() || ref.name,
      contentType: record.contentType,
      byteSize: record.byteSize,
      openPath: record.openPath,
      downloadPath: record.downloadPath,
    };
  });
}

/**
 * Markdown links (not `![]` embeds) pointing at attachment/asset content. The
 * label admits backslash-escaped characters — the composer escapes `[`/`]` in
 * filenames when inserting references.
 */
const ATTACHMENT_LINK_RE =
  /(?<!!)\[((?:\\.|[^\]\\])+)\]\((\/api\/(?:attachments|assets)\/[^()\s]+\/content(?:\?[^()\s]*)?)\)/g;

/** Markdown image embeds (`![name](url)`), same escaped-label grammar. */
const IMAGE_EMBED_RE = /!\[((?:\\.|[^\]\\])*)\]\(([^()\s]+)\)/g;

function isStandaloneImageEmbedLine(line: string): boolean {
  return (
    line.replace(IMAGE_EMBED_RE, "").trim().length === 0 && line.trim().length > 0
  );
}

/**
 * Images on standalone lines, in document order, deduped by URL. Images woven
 * into prose stay inline so they are not also duplicated in the media strip.
 * Feeds the bubble's lightbox: the refs become the gallery items and the
 * clicked <img> src picks the initial index.
 */
export function extractImageRefs(body: string): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  const seen = new Set<string>();
  for (const line of body.split("\n")) {
    if (!isStandaloneImageEmbedLine(line)) continue;
    for (const match of line.matchAll(IMAGE_EMBED_RE)) {
      const [, name, url] = match;
      if (seen.has(url)) continue;
      seen.add(url);
      refs.push({ name: name.replace(/\\([[\]])/g, "$1"), url });
    }
  }
  return refs;
}

/** Remove standalone image-embed lines after promoting them to the media strip. */
export function stripStandaloneImageEmbeds(body: string): string {
  return body
    .split("\n")
    .filter((line) => !isStandaloneImageEmbedLine(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface ExtractedAttachmentRefs {
  refs: AttachmentRef[];
  /** Body with lines that were nothing but extracted links removed. */
  text: string;
}

/**
 * Pull non-image attachment references out of a message body. Every matching
 * link becomes a chip; a line is stripped from the rendered body only when it
 * contains nothing but extracted links (the shape the composer inserts), so
 * links woven into prose keep their sentence.
 */
export function extractAttachmentRefs(body: string): ExtractedAttachmentRefs {
  const refs: AttachmentRef[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(ATTACHMENT_LINK_RE)) {
    const [, name, url] = match;
    if (seen.has(url)) continue;
    seen.add(url);
    refs.push({ name: name.replace(/\\([[\]])/g, "$1"), url });
  }
  if (refs.length === 0) return { refs, text: body };

  const kept = body.split("\n").filter((line) => {
    const withoutLinks = line.replace(ATTACHMENT_LINK_RE, (full, name: string, url: string) => {
      return seen.has(url) ? "" : full;
    });
    return withoutLinks.trim().length > 0 || line.trim().length === 0;
  });
  // Collapse the blank run left behind where a link-only line was removed.
  const text = kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { refs, text };
}
