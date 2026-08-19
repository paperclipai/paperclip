import { extname } from "node:path";

type AttachmentArchiveInput = {
  id: string;
  contentType: string;
  originalFilename: string | null;
};

type DocumentArchiveInput = {
  key: string;
};

const CONTENT_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  "application/json": ".json",
  "application/pdf": ".pdf",
  "application/zip": ".zip",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/svg+xml": ".svg",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/html": ".html",
  "text/markdown": ".md",
  "text/plain": ".txt",
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-m4v": ".m4v",
};

export function sanitizeArchivePathSegment(value: string, fallback: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[\\/]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\.{2,}/g, ".")
    .replace(/^\.+/, "")
    .trim();
  return sanitized || fallback;
}

function inferredAttachmentExtension(contentType: string): string {
  return CONTENT_TYPE_EXTENSIONS[contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""] ?? "";
}

function suffixDuplicateFilename(filename: string, suffix: number): string {
  const extension = extname(filename);
  const stem = extension ? filename.slice(0, -extension.length) : filename;
  return `${stem}-${suffix}${extension}`;
}

function allocateUniquePath(directory: string, filename: string, usedPaths: Set<string>): string {
  let candidate = `${directory}/${filename}`;
  let suffix = 2;
  while (usedPaths.has(candidate.toLowerCase())) {
    candidate = `${directory}/${suffixDuplicateFilename(filename, suffix)}`;
    suffix += 1;
  }
  usedPaths.add(candidate.toLowerCase());
  return candidate;
}

export function buildAttachmentArchivePaths(attachments: AttachmentArchiveInput[]): Map<string, string> {
  const usedPaths = new Set<string>();
  const paths = new Map<string, string>();
  const sorted = [...attachments].sort((left, right) => left.id.localeCompare(right.id));

  for (const attachment of sorted) {
    const fallbackBase = sanitizeArchivePathSegment(`attachment-${attachment.id}`, "attachment");
    const fallback = `${fallbackBase}${inferredAttachmentExtension(attachment.contentType)}`;
    const filename = sanitizeArchivePathSegment(attachment.originalFilename ?? "", fallback);
    paths.set(attachment.id, allocateUniquePath("attachments", filename, usedPaths));
  }

  return paths;
}

export function buildDocumentArchivePath(document: DocumentArchiveInput): string {
  const key = sanitizeArchivePathSegment(document.key, "document");
  return `documents/${key.toLowerCase().endsWith(".md") ? key : `${key}.md`}`;
}

export function buildIssueAttachmentArchiveFilename(identifier: string): string {
  const safeIdentifier = sanitizeArchivePathSegment(identifier, "task").replace(/[";=]/g, "-");
  return `attachments-${safeIdentifier}.zip`;
}
