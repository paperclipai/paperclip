import { randomBytes } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import { formatBytes, type GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import {
  DRIVE_BASE,
  DRIVE_HOST,
  DRIVE_UPLOAD_BASE,
  fileFields,
  fileId,
  fileSchema,
  GOOGLE_DOC,
  GOOGLE_FOLDER,
  GOOGLE_SHEET,
  GOOGLE_SLIDES,
  isGoogleType,
  MAX_UPLOAD_BYTES,
  mimeTypeArg,
  toMcpFile,
  writeScopeHint,
  type RestFile,
} from "./file.js";

const MAX_BASE64_LENGTH = Math.ceil(MAX_UPLOAD_BYTES / 3) * 4 + 1024;
const base64Arg = z.string().max(MAX_BASE64_LENGTH * 2);

const args = z.object({
  title: z.string().min(1).max(1024),
  contentMimeType: mimeTypeArg.optional(),
  mimeType: mimeTypeArg.optional(),
  base64Content: base64Arg.optional(),
  textContent: z.string().max(MAX_UPLOAD_BYTES).optional(),
  content: base64Arg.optional(),
  parentId: fileId.optional(),
  disableConversionToGoogleType: z.boolean().optional(),
  inheritedPermissionsDisabled: z.boolean().optional(),
  pregeneratedId: fileId.optional(),
});
export type CreateFileArgs = z.infer<typeof args>;

export const EMPTY_CREATABLE = new Set([GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES, GOOGLE_FOLDER]);

export const CONVERSIONS: Readonly<Record<string, string>> = {
  "text/plain": GOOGLE_DOC,
  "text/html": GOOGLE_DOC,
  "text/markdown": GOOGLE_DOC,
  "application/rtf": GOOGLE_DOC,
  "text/rtf": GOOGLE_DOC,
  "application/msword": GOOGLE_DOC,
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": GOOGLE_DOC,
  "application/vnd.oasis.opendocument.text": GOOGLE_DOC,
  "text/csv": GOOGLE_SHEET,
  "text/tab-separated-values": GOOGLE_SHEET,
  "application/vnd.ms-excel": GOOGLE_SHEET,
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": GOOGLE_SHEET,
  "application/vnd.oasis.opendocument.spreadsheet": GOOGLE_SHEET,
  "application/vnd.ms-powerpoint": GOOGLE_SLIDES,
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": GOOGLE_SLIDES,
  "application/vnd.oasis.opendocument.presentation": GOOGLE_SLIDES,
};

function invalid(message: string): GoogleToolError {
  return new GoogleToolError("invalid_argument", `${message} Nothing was created.`);
}

export function decodeBase64(value: string): Buffer {
  const compacted = value.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compacted) || compacted.replace(/=+$/, "").length % 4 === 1) {
    throw invalid("base64Content is not valid base64.");
  }
  return Buffer.from(compacted, "base64");
}

export interface CreatePlan { metadata: RestFile & { id?: string; inheritedPermissionsDisabled?: boolean }; media?: { contentType: string; data: Buffer } }

export function createPlan(input: CreateFileArgs): CreatePlan {
  const given = [input.base64Content, input.textContent, input.content].filter((value) => value !== undefined);
  if (given.length > 1) throw invalid("Pass only one of textContent, base64Content and content.");
  const contentType = input.contentMimeType ?? input.mimeType;
  const parents = input.parentId ? [input.parentId] : undefined;
  const base = { name: input.title, parents, id: input.pregeneratedId };
  if (given.length === 0) {
    if (!contentType || !EMPTY_CREATABLE.has(contentType)) {
      throw invalid(`Without content, contentMimeType must be one of ${[...EMPTY_CREATABLE].join(", ")}.`);
    }
    if (input.pregeneratedId && contentType !== GOOGLE_FOLDER) throw invalid("pregeneratedId cannot be used for Google Docs, Sheets or Slides.");
    if (input.inheritedPermissionsDisabled && contentType !== GOOGLE_FOLDER) throw invalid("inheritedPermissionsDisabled applies to folders only.");
    return { metadata: compact({ ...base, mimeType: contentType, inheritedPermissionsDisabled: input.inheritedPermissionsDisabled || undefined }) };
  }
  if (!contentType) throw invalid("contentMimeType is required when content is given.");
  if (isGoogleType(contentType)) throw invalid("contentMimeType must be the type of the uploaded content, not a Google file type.");
  if (input.inheritedPermissionsDisabled) throw invalid("inheritedPermissionsDisabled applies to folders only.");
  const data = input.textContent !== undefined ? Buffer.from(input.textContent, "utf8") : decodeBase64((input.base64Content ?? input.content)!);
  if (data.byteLength > MAX_UPLOAD_BYTES) {
    throw new GoogleToolError("too_large", `The content is ${data.byteLength} bytes; this tool uploads at most ${formatBytes(MAX_UPLOAD_BYTES)}. Nothing was created.`);
  }
  const target = input.disableConversionToGoogleType ? undefined : CONVERSIONS[contentType];
  if (input.pregeneratedId && target) throw invalid("With pregeneratedId and content, set disableConversionToGoogleType to true.");
  return { metadata: compact({ ...base, mimeType: target ?? contentType }), media: { contentType, data } };
}

export function multipartBody(metadata: object, media: { contentType: string; data: Buffer }, boundary: string): Buffer {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${media.contentType}\r\n\r\n`, "utf8"),
    media.data,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
}

export function createFileRequest(plan: CreatePlan, boundary: string): GoogleRequest {
  const query = { fields: fileFields(), supportsAllDrives: true };
  if (!plan.media) return { method: "POST", host: DRIVE_HOST, path: `${DRIVE_BASE}/files`, query, body: plan.metadata };
  return {
    method: "POST",
    host: DRIVE_HOST,
    path: `${DRIVE_UPLOAD_BASE}/files`,
    query: { uploadType: "multipart", ...query },
    upload: { contentType: `multipart/related; boundary=${boundary}`, data: multipartBody(plan.metadata, plan.media, boundary) },
  };
}

export function createFileResult(file: RestFile): CallToolResult {
  return structuredResult(toMcpFile(file));
}

export const createFile = defineTool({
  definition: {
    name: "create_file",
    description: "Creates a new file in Google Drive and returns it. It never changes or replaces an existing file. Prefer textContent for text; use base64Content for other bytes. Content is at most 5 MB. contentMimeType is required with content. By default, content Google can convert becomes a Google file: text, Markdown, HTML, RTF and Word files become Google Docs; CSV, TSV and Excel files become Sheets; PowerPoint files become Slides. Set disableConversionToGoogleType to keep the uploaded type. Without content, contentMimeType must be application/vnd.google-apps.document, application/vnd.google-apps.spreadsheet, application/vnd.google-apps.presentation or application/vnd.google-apps.folder. With Drive file access (drive.file), parentId must be a folder this app created or was given.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Required. Title of the new file." },
        contentMimeType: { type: "string", description: "MIME type of the uploaded content; required when content is given. Without content, the Google file type to create." },
        textContent: { type: "string", description: "Optional. UTF-8 text to upload. Do not combine with base64Content." },
        base64Content: { type: "string", description: "Optional. Base64-encoded bytes to upload. Do not combine with textContent." },
        content: { type: "string", description: "Deprecated: use base64Content or textContent. Base64-encoded content." },
        mimeType: { type: "string", description: "Deprecated: use contentMimeType." },
        parentId: { type: "string", description: "Optional. ID of the folder to create the file in. Default: My Drive." },
        disableConversionToGoogleType: { type: "boolean", description: "Optional. Keep the uploaded MIME type instead of converting to a Google Docs, Sheets or Slides file. Default: false." },
        inheritedPermissionsDisabled: { type: "boolean", description: "Optional. For a new folder: do not inherit the parent folder's sharing." },
        pregeneratedId: { type: "string", description: "Optional. A Drive-generated ID to give the new file. Only for folders and files that are not converted (set disableConversionToGoogleType)." },
      },
      required: ["title"],
    },
    outputSchema: fileSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  args,
  async run(input, http) {
    const request = createFileRequest(createPlan(input), randomBytes(16).toString("hex"));
    try {
      return createFileResult(await http.send<RestFile>(request));
    } catch (error) {
      throw input.parentId ? writeScopeHint(error, "the parent folder") : error;
    }
  },
});
