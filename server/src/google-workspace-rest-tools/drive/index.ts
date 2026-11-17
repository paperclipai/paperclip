import type { GoogleRequest } from "../google-http.js";
import type { RestTool } from "../tool.js";
import { copyFile } from "./copy-file.js";
import { createFile } from "./create-file.js";
import { downloadFileContent } from "./download-file-content.js";
import { DRIVE_BASE, DRIVE_HOST } from "./file.js";
import { getFileMetadata } from "./get-file-metadata.js";
import { getFilePermissions } from "./get-file-permissions.js";
import { listRecentFiles } from "./list-recent-files.js";
import { readFileContent } from "./read-file-content.js";
import { searchFiles } from "./search-files.js";

export const DRIVE_TOOLS: readonly RestTool[] = [
  searchFiles, listRecentFiles, getFileMetadata, getFilePermissions, readFileContent, downloadFileContent, createFile, copyFile,
];

export function driveProbeRequest(): GoogleRequest {
  return { method: "GET", host: DRIVE_HOST, path: `${DRIVE_BASE}/about`, query: { fields: "kind" } };
}
