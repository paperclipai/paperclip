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

const KIND_BY_EXTENSION: Record<string, FileKind> = {
  pdf: { icon: FileText, label: "PDF" },
  doc: { icon: FileText, label: "Doc" },
  docx: { icon: FileText, label: "Doc" },
  txt: { icon: FileText, label: "Text" },
  md: { icon: FileText, label: "Markdown" },
  rtf: { icon: FileText, label: "Text" },
  csv: { icon: FileSpreadsheet, label: "CSV" },
  tsv: { icon: FileSpreadsheet, label: "TSV" },
  xls: { icon: FileSpreadsheet, label: "Sheet" },
  xlsx: { icon: FileSpreadsheet, label: "Sheet" },
  zip: { icon: FileArchive, label: "ZIP" },
  gz: { icon: FileArchive, label: "Archive" },
  tar: { icon: FileArchive, label: "Archive" },
  tgz: { icon: FileArchive, label: "Archive" },
  rar: { icon: FileArchive, label: "Archive" },
  "7z": { icon: FileArchive, label: "Archive" },
  mp3: { icon: FileAudio, label: "Audio" },
  wav: { icon: FileAudio, label: "Audio" },
  m4a: { icon: FileAudio, label: "Audio" },
  ogg: { icon: FileAudio, label: "Audio" },
  mp4: { icon: FileVideo, label: "Video" },
  mov: { icon: FileVideo, label: "Video" },
  webm: { icon: FileVideo, label: "Video" },
  json: { icon: FileCode, label: "JSON" },
  yaml: { icon: FileCode, label: "YAML" },
  yml: { icon: FileCode, label: "YAML" },
  xml: { icon: FileCode, label: "XML" },
  html: { icon: FileCode, label: "HTML" },
  css: { icon: FileCode, label: "CSS" },
  js: { icon: FileCode, label: "Code" },
  jsx: { icon: FileCode, label: "Code" },
  ts: { icon: FileCode, label: "Code" },
  tsx: { icon: FileCode, label: "Code" },
  py: { icon: FileCode, label: "Code" },
  rb: { icon: FileCode, label: "Code" },
  go: { icon: FileCode, label: "Code" },
  rs: { icon: FileCode, label: "Code" },
  sh: { icon: FileCode, label: "Code" },
  sql: { icon: FileCode, label: "SQL" },
  log: { icon: FileText, label: "Log" },
  patch: { icon: FileCode, label: "Patch" },
  diff: { icon: FileCode, label: "Patch" },
};

function extensionOf(name: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(name.trim());
  return match ? match[1].toLowerCase() : "";
}

export function isImageFilename(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/** Kind icon + short label for a filename; unknown extensions get File/"File". */
export function fileKindForName(name: string): FileKind {
  return KIND_BY_EXTENSION[extensionOf(name)] ?? { icon: FileIcon, label: "File" };
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

/**
 * Every image embedded in a message body, in document order, deduped by URL.
 * Feeds the bubble's lightbox: the refs become the gallery items and the
 * clicked <img> src picks the initial index.
 */
export function extractImageRefs(body: string): AttachmentRef[] {
  const refs: AttachmentRef[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(IMAGE_EMBED_RE)) {
    const [, name, url] = match;
    if (seen.has(url)) continue;
    seen.add(url);
    refs.push({ name: name.replace(/\\([[\]])/g, "$1"), url });
  }
  return refs;
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
    if (isImageFilename(name) || isImageFilename(url.split("?")[0])) continue;
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
