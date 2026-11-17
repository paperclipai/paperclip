import { GoogleToolError } from "../errors.js";
import { formatBytes, type GoogleHttp, type GoogleRequest } from "../google-http.js";
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
  MAX_CONTENT_BYTES,
  type RestFile,
} from "./file.js";

export const CONTENT_META_FIELDS = "id,name,mimeType,size";

export const DEFAULT_DOWNLOAD_EXPORTS: Readonly<Record<string, string>> = {
  [GOOGLE_DOC]: "text/plain",
  [GOOGLE_SHEET]: "text/csv",
  [GOOGLE_SLIDES]: "text/plain",
  [GOOGLE_DRAWING]: "image/svg+xml",
  [GOOGLE_SCRIPT]: "application/vnd.google-apps.script+json",
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

export function assertWithinCap(file: RestFile): void {
  const size = Number(file.size ?? "0");
  if (size > MAX_CONTENT_BYTES) {
    throw new GoogleToolError(
      "too_large",
      `This file is ${size} bytes, larger than ${formatBytes(MAX_CONTENT_BYTES)}, the most this tool returns. Nothing was returned.`,
    );
  }
}

export function downloadPlan(file: RestFile, exportMimeType: string | undefined, revision: string | undefined): ContentPlan {
  const id = file.id ?? "";
  const mimeType = file.mimeType ?? "application/octet-stream";
  if (isGoogleType(mimeType)) {
    const target = exportMimeType ?? DEFAULT_DOWNLOAD_EXPORTS[mimeType];
    if (!target) throw new GoogleToolError("unsupported", `Files of type ${mimeType} have no content to download.`);
    if (revision) throw new GoogleToolError("unsupported", "Earlier revisions of Google Docs, Sheets, Slides and other Google files cannot be downloaded with this tool. Omit revisionId to export the current version.");
    return { request: exportRequest(id, target), contentType: target };
  }
  if (!revision) assertWithinCap(file);
  return { request: mediaRequest(id, revision), contentType: mimeType };
}

export async function readContentMeta(id: string, http: GoogleHttp): Promise<RestFile> {
  return http.send<RestFile>(contentMetaRequest(id));
}

export async function fetchContent(plan: ContentPlan, http: GoogleHttp): Promise<Buffer> {
  return (await http.download(plan.request, MAX_CONTENT_BYTES)).data;
}
