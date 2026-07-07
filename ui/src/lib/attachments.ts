// Shared attachment staging constants + helpers for issue/task creation flows
// (NewIssueDialog, TalkToTeam). Keeps the accepted MIME/extension set in one
// place so both entry points stay in sync with the server allowlist in
// server/src/attachment-types.ts (DEFAULT_ALLOWED_TYPES).

/** Accept attribute for staged-file inputs: MIME types + extension fallbacks. */
export const STAGED_FILE_ACCEPT = [
  "image/*",
  "application/pdf",
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "text/tab-separated-values",
  "text/html",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/zip",
  "application/x-zip-compressed",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".xls",
  ".xlsx",
  ".xlsm",
  ".ods",
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".zip",
].join(",");

/** Max number of files that can be attached to a single task from the Talk console. */
export const MAX_TASK_ATTACHMENTS = 10;

/** Stable identity for a picked File, used to dedupe across multiple picks/drops. */
export function stagedFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

/** Human-readable byte size (e.g. "3.4 MB"). */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
