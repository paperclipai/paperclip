import { GoogleToolError } from "../errors.js";
import { byteCount } from "../tool.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import {
  DRIVE_HOST,
  filePath,
  getFileRequest,
  GOOGLE_DOC,
  GOOGLE_DRAWING,
  GOOGLE_SCRIPT,
  GOOGLE_SHEET,
  GOOGLE_SLIDES,
  isGoogleType,
  type RestFile,
} from "./file.js";

export const CONTENT_META_FIELDS = "id,name,mimeType,size";

const PDF = "application/pdf";
export const EXPORT_FORMATS: Readonly<Record<string, readonly string[]>> = {
  [GOOGLE_DOC]: [
    "text/plain", "text/markdown", "text/html", "application/rtf", PDF, "application/epub+zip", "application/zip",
    "application/vnd.oasis.opendocument.text", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ],
  [GOOGLE_SHEET]: [
    "text/csv", "text/tab-separated-values", PDF, "application/zip",
    "application/vnd.oasis.opendocument.spreadsheet", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ],
  [GOOGLE_SLIDES]: [
    "text/plain", PDF, "application/vnd.oasis.opendocument.presentation",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ],
  [GOOGLE_DRAWING]: ["image/svg+xml", "image/png", "image/jpeg", PDF],
  [GOOGLE_SCRIPT]: ["application/vnd.google-apps.script+json"],
};

export interface ContentPlan {
  request: GoogleRequest;
  contentType: string;
}

export function contentMetaRequest(id: string): GoogleRequest {
  return getFileRequest(id, CONTENT_META_FIELDS);
}

export function exportRequest(id: string, mimeType: string): GoogleRequest {
  return { method: "GET", host: DRIVE_HOST, path: `${filePath(id)}/export`, query: { mimeType } };
}

export function mediaRequest(id: string, revision?: string): GoogleRequest {
  const path = revision ? `${filePath(id)}/revisions/${encodeURIComponent(revision)}` : filePath(id);
  return { method: "GET", host: DRIVE_HOST, path, query: { alt: "media", supportsAllDrives: revision ? undefined : true } };
}

export function tooLargeContent(advice: string, maxBytes: number, size?: number): GoogleToolError {
  const what = size === undefined ? "This file's content is" : `This file is ${byteCount(size)} bytes,`;
  return new GoogleToolError("too_large", `${what} more than the ${byteCount(maxBytes)} bytes this tool can return, so nothing was returned. ${advice}`);
}

export function assertWithinCap(file: RestFile, advice: string, maxBytes: number): void {
  const size = Number(file.size ?? "0");
  if (size > maxBytes) throw tooLargeContent(advice, maxBytes, size);
}

export function exportFormat(mimeType: string, requested: string | undefined): string {
  const formats = EXPORT_FORMATS[mimeType];
  if (!formats) throw new GoogleToolError("unsupported", `Files of type ${mimeType} have no content to download.`);
  if (requested === undefined) return formats[0]!;
  if (!formats.includes(requested)) {
    throw new GoogleToolError("invalid_argument", `This file cannot be exported as ${requested}. Use one of: ${formats.join(", ")}.`);
  }
  return requested;
}

export function downloadPlan(id: string, file: RestFile, exportMimeType: string | undefined, revision: string | undefined, advice: string, maxBytes: number): ContentPlan {
  const mimeType = file.mimeType ?? "application/octet-stream";
  if (isGoogleType(mimeType)) {
    const target = exportFormat(mimeType, exportMimeType);
    if (revision) throw new GoogleToolError("unsupported", "Earlier revisions of Google Docs, Sheets, Slides and other Google files cannot be downloaded with this tool. Omit revisionId to export the current version.");
    return { request: exportRequest(id, target), contentType: target };
  }
  if (!revision) assertWithinCap(file, advice, maxBytes);
  return { request: mediaRequest(id, revision), contentType: mimeType };
}

export async function readContentMeta(id: string, http: GoogleHttp): Promise<RestFile> {
  return http.send<RestFile>(contentMetaRequest(id));
}

export async function fetchContent(plan: ContentPlan, http: GoogleHttp, advice: string, maxBytes: number): Promise<Buffer> {
  try {
    return (await http.download(plan.request, maxBytes)).data;
  } catch (error) {
    if (error instanceof GoogleToolError && error.kind === "too_large" && error.httpStatus !== 403) throw tooLargeContent(advice, maxBytes);
    throw error;
  }
}
