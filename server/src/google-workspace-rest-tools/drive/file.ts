import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { compact } from "../tool.js";

export const DRIVE_HOST = "www.googleapis.com" as const;
export const DRIVE_BASE = "/drive/v3";
export const DRIVE_UPLOAD_BASE = "/upload/drive/v3";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;

export const GOOGLE_DOC = "application/vnd.google-apps.document";
export const GOOGLE_SHEET = "application/vnd.google-apps.spreadsheet";
export const GOOGLE_SLIDES = "application/vnd.google-apps.presentation";
export const GOOGLE_DRAWING = "application/vnd.google-apps.drawing";
export const GOOGLE_SCRIPT = "application/vnd.google-apps.script";
export const GOOGLE_FOLDER = "application/vnd.google-apps.folder";
export const GOOGLE_APPS_PREFIX = "application/vnd.google-apps.";

export const fileId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, "Must be a Drive file ID");
export const revisionId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, "Must be a Drive revision ID");
export const mimeTypeArg = z.string().max(255).regex(/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/, "Must be a MIME type such as text/plain");
export const pageSizeArg = z.number().int().min(1).optional();
export const pageTokenArg = z.string().max(4096).optional();

export const SNIPPET_VERBOSITIES = ["UNSPECIFIED", "BRIEF", "MEDIUM", "DETAILED", "MAX_ALLOWED"] as const;
export const snippetArgs = {
  excludeContentSnippets: z.boolean().optional(),
  snippetVerbosity: z.enum(SNIPPET_VERBOSITIES).optional(),
};

export function assertSnippetArgs(input: { excludeContentSnippets?: boolean; snippetVerbosity?: string }): void {
  if (input.excludeContentSnippets === true && input.snippetVerbosity !== undefined) {
    throw new GoogleToolError("invalid_argument", "Set either excludeContentSnippets or snippetVerbosity, not both.");
  }
}

export function pageSize(value: number | undefined): number {
  return Math.min(value ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
}

export function filePath(id: string): string {
  return `${DRIVE_BASE}/files/${encodeURIComponent(id)}`;
}

export interface RestUser { displayName?: string; emailAddress?: string }
export interface RestPermission {
  id?: string; type?: string; role?: string; emailAddress?: string; displayName?: string; domain?: string;
  allowFileDiscovery?: boolean; view?: string; deleted?: boolean;
}
export interface RestFile {
  id?: string; name?: string; mimeType?: string; parents?: string[]; size?: string; description?: string;
  fileExtension?: string; webViewLink?: string; sharedWithMeTime?: string; createdTime?: string;
  modifiedTime?: string; viewedByMeTime?: string; owners?: RestUser[]; lastModifyingUser?: RestUser;
  capabilities?: { canAddChildren?: boolean }; permissions?: RestPermission[]; trashed?: boolean;
}
export interface RestFileList { files?: RestFile[]; nextPageToken?: string; incompleteSearch?: boolean }

const BASE_FIELDS = "id,name,mimeType,parents,size,description,fileExtension,webViewLink,sharedWithMeTime,createdTime,modifiedTime,viewedByMeTime,owners(emailAddress),capabilities(canAddChildren)";
const RICH_FIELDS = "owners(emailAddress,displayName),lastModifyingUser(displayName,emailAddress),permissions(type,allowFileDiscovery)";

export function fileFields(rich = false): string {
  return rich ? `${BASE_FIELDS.replace(",owners(emailAddress)", "")},${RICH_FIELDS}` : BASE_FIELDS;
}

export function listFields(rich = false): string {
  return `nextPageToken,incompleteSearch,files(${fileFields(rich)})`;
}

export function getFileRequest(id: string, fields: string): GoogleRequest {
  return { method: "GET", host: DRIVE_HOST, path: filePath(id), query: { fields, supportsAllDrives: true } };
}

export function visibility(permissions: RestPermission[] | undefined): string | undefined {
  if (!permissions) return undefined;
  const live = permissions.filter((permission) => !permission.deleted);
  const anyone = live.filter((permission) => permission.type === "anyone");
  if (anyone.some((permission) => permission.allowFileDiscovery)) return "anyoneCanFind";
  if (anyone.length) return "anyoneWithLink";
  const domain = live.filter((permission) => permission.type === "domain");
  if (domain.some((permission) => permission.allowFileDiscovery)) return "domainCanFind";
  if (domain.length) return "domainWithLink";
  return "limited";
}

export function toMcpFile(file: RestFile, rich = false): Record<string, unknown> {
  const owner = file.owners?.[0];
  return compact({
    id: file.id ?? "",
    title: file.name ?? "",
    parentId: file.parents?.[0],
    mimeType: file.mimeType,
    fileSize: file.size,
    description: file.description,
    fileExtension: file.fileExtension,
    viewUrl: file.webViewLink,
    sharedWithMeTime: file.sharedWithMeTime,
    createdTime: file.createdTime,
    modifiedTime: file.modifiedTime,
    viewedByMeTime: file.viewedByMeTime,
    owner: owner?.emailAddress,
    canAddChildren: file.mimeType === GOOGLE_FOLDER ? file.capabilities?.canAddChildren ?? false : false,
    ownerName: rich ? owner?.displayName : undefined,
    lastModifyingUserName: rich ? file.lastModifyingUser?.displayName : undefined,
    lastModifyingUserEmail: rich ? file.lastModifyingUser?.emailAddress : undefined,
    visibility: rich ? visibility(file.permissions) : undefined,
  });
}

const str = (description: string) => ({ type: "string", description });

export const fileSchema = {
  type: "object",
  properties: {
    id: str("The file's ID."),
    title: str("The file's title."),
    parentId: str("ID of the file's parent folder."),
    mimeType: str("The file's MIME type."),
    fileSize: str("Size in bytes (int64 as a string). Absent for Google Docs, Sheets, Slides and folders."),
    description: str("The file's description."),
    fileExtension: str("The original file extension. Only for files whose content is stored in Drive."),
    contentSnippet: str("Not returned by this implementation."),
    viewUrl: str("Link to open the file in a browser."),
    sharedWithMeTime: str("When the file was shared with the user (RFC 3339)."),
    createdTime: str("When the file was created (RFC 3339)."),
    modifiedTime: str("When the file was last modified by anyone (RFC 3339)."),
    viewedByMeTime: str("When the user last viewed the file (RFC 3339)."),
    owner: str("Email address of the file's owner. Absent for files in shared drives."),
    canAddChildren: { type: "boolean", description: "Whether the user can add files to this folder. Always false for files that are not folders." },
    ownerName: str("Owner's name. Only with includeRichMetadata."),
    lastModifyingUserName: str("Name of the last person to modify the file. Only with includeRichMetadata."),
    lastModifyingUserEmail: str("Email address of the last person to modify the file. Only with includeRichMetadata."),
    visibility: str("Link sharing: anyoneCanFind, anyoneWithLink, domainCanFind, domainWithLink or limited. Only with includeRichMetadata, and only when the user can see the file's sharing."),
  },
  required: ["id", "title"] as string[],
} as const;

export const fileListSchema = {
  type: "object",
  properties: {
    files: { type: "array", items: fileSchema, description: "The files." },
    nextPageToken: str("Pass as pageToken to get the next page. Absent on the last page."),
    incompleteSearch: { type: "boolean", description: "True when Google could not search every place the user's files are, so matching files may be missing. Absent otherwise. Narrow the query or treat a missing file as not found yet, not as absent." },
  },
  required: ["files"] as string[],
} as const;

export const fileIdInput = (purpose: string) => str(`Required. ${purpose} A Drive file ID, from search_files or list_recent_files.`);
export const snippetInputs = {
  excludeContentSnippets: { type: "boolean", description: "Optional. Accepted for compatibility. This implementation never returns content snippets." },
  snippetVerbosity: {
    type: "string",
    enum: [...SNIPPET_VERBOSITIES],
    description: "Optional. Accepted for compatibility. This implementation never returns content snippets. Must not be set when excludeContentSnippets is true.",
  },
};
export const richMetadataInput = {
  type: "boolean",
  description: "Optional. When true, also returns ownerName, lastModifyingUserName, lastModifyingUserEmail and visibility. Default: false.",
};

export function listResult(list: RestFileList, rich = false): Record<string, unknown> {
  return compact({
    files: (list.files ?? []).map((file) => toMcpFile(file, rich)),
    nextPageToken: list.nextPageToken || undefined,
    incompleteSearch: list.incompleteSearch === true ? true : undefined,
  });
}

export const READ_LESS = {
  download: "This tool cannot return part of a file. For a Google Docs, Sheets or Slides file, read its text with read_file_content or choose a smaller export format with exportMimeType.",
  read: "This tool cannot return part of a file. Read it without includeComments if that was set; larger files cannot be read with these tools.",
  list: "Ask for fewer files with a smaller pageSize, or leave out includeRichMetadata.",
  metadata: "Leave out includeRichMetadata.",
  permissions: "This file has too many permissions to list with this tool.",
} as const;

export function isGoogleType(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.startsWith(GOOGLE_APPS_PREFIX));
}

export function writeScopeHint(error: unknown, what: string): unknown {
  if (error instanceof GoogleToolError && error.kind === "not_found") {
    return new GoogleToolError(
      "not_found",
      `Google could not find ${what}, or this connection cannot use it: with drive.file access it can only use files and folders that this app created or that were opened with it. Nothing was created.`,
      error.httpStatus,
    );
  }
  return error;
}
