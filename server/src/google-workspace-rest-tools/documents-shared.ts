import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "./errors.js";
import type { GoogleHttp, GoogleRequest } from "./google-http.js";

export const MAX_RESULT_BYTES = 1_000_000;
export const MAX_BATCH_REQUESTS = 500;
export const OBJECT_PLACEHOLDER = "￼";

export const fileIdArg = (kind: string) => z.string().regex(/^[A-Za-z0-9_-]{1,256}$/, `Must be a Google ${kind} ID`);
export const revisionIdArg = z.string().min(1).max(1024);

export const batchRequestArg = z.record(z.string(), z.unknown()).refine(
  (value) => Object.keys(value).length === 1,
  "Each request must name exactly one kind of update, such as insertText",
);

export function sizedResult(value: Record<string, unknown>, what: string, hint: string): CallToolResult {
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_RESULT_BYTES) {
    const size = (bytes / 1_000_000).toFixed(1);
    throw new GoogleToolError("incomplete", `This ${what} is too large to return in one result (${size} MB; the limit is 1 MB). Nothing was returned. ${hint}`);
  }
  return { content: [{ type: "text", text }], structuredContent: value };
}

const CONFLICT_STATUSES = new Set(["FAILED_PRECONDITION", "ABORTED"]);
const CONFLICT_REASON = /REVISION|CONDITION_NOT_MET|conditionNotMet/i;
const CONFLICT_MESSAGE = /\brequired revision\b|\brevision id\b|\blatest revision\b/i;

export function isRevisionConflict(error: GoogleToolError): boolean {
  if (error.kind !== "invalid_argument" || (error.httpStatus !== 400 && error.httpStatus !== 409)) return false;
  if (error.google.status && CONFLICT_STATUSES.has(error.google.status)) return true;
  if ((error.google.reasons ?? []).some((reason) => CONFLICT_REASON.test(reason))) return true;
  return CONFLICT_MESSAGE.test(error.message);
}

export function assertRequestKinds(requests: ReadonlyArray<Record<string, unknown>>, blocked: Readonly<Record<string, string>>): void {
  const refused = [...new Set(requests.map((request) => Object.keys(request)[0]!).filter((kind) => Object.hasOwn(blocked, kind)))];
  if (refused.length) {
    throw new GoogleToolError("invalid_argument", `${refused.map((kind) => `${kind} ${blocked[kind]}`).join(" ")} This tool only changes the one file it is given. Nothing was changed.`);
  }
}

export interface TableCellText {
  text: string;
  rowSpan?: number;
  columnSpan?: number;
  row?: number;
  column?: number;
}

export const MERGED_LEFT = "(merged left)";
export const MERGED_UP = "(merged up)";

const span = (value: number | undefined) => (value !== undefined && value > 1 ? Math.floor(value) : 1);

export function tableGrid(rows: readonly (readonly TableCellText[])[], columns: number): string[][] {
  const grid: Array<Array<string | undefined>> = rows.map(() => []);
  for (const [listedRow, cells] of rows.entries()) {
    const positional = cells.length === columns && cells.every((cell) => cell.column === undefined);
    let column = 0;
    for (const [cellIndex, cell] of cells.entries()) {
      const rowIndex = cell.row !== undefined && cell.row >= 0 && cell.row < rows.length ? cell.row : listedRow;
      if (positional) column = cellIndex;
      else if (cell.column !== undefined) column = cell.column;
      else while (grid[rowIndex]![column] !== undefined) column += 1;
      if (positional && grid[rowIndex]![column] !== undefined && cell.text === "") continue;
      grid[rowIndex]![column] = cell.text;
      for (let down = 0; down < span(cell.rowSpan) && rowIndex + down < rows.length; down += 1) {
        for (let across = 0; across < span(cell.columnSpan); across += 1) {
          if (down === 0 && across === 0) continue;
          grid[rowIndex + down]![column + across] = down === 0 ? MERGED_LEFT : MERGED_UP;
        }
      }
      column += span(cell.columnSpan);
    }
  }
  const width = Math.max(columns, ...grid.map((row) => row.length));
  return grid.map((row) => Array.from({ length: width }, (_, index) => row[index] ?? ""));
}

export function markdownTable(rows: readonly (readonly TableCellText[])[], columns: number): string[] {
  if (rows.length === 0) return ["[empty table]"];
  const grid = tableGrid(rows, columns);
  const lines = grid.map((cells) => `| ${cells.join(" | ")} |`);
  return [lines[0]!, `| ${grid[0]!.map(() => "---").join(" | ")} |`, ...lines.slice(1)];
}

export async function readWithComments<T>(http: GoogleHttp, request: GoogleRequest, plain: GoogleRequest | undefined, unavailable: string): Promise<T> {
  try {
    return await http.send<T>(request);
  } catch (error) {
    if (!plain || !(error instanceof GoogleToolError) || error.kind !== "permission_denied") throw error;
    await http.send(plain);
    throw new GoogleToolError("permission_denied", unavailable, error.httpStatus);
  }
}

export async function sendBatchUpdate<T>(http: GoogleHttp, request: GoogleRequest, what: string, readTool: string): Promise<T> {
  try {
    return await http.send<T>(request);
  } catch (error) {
    if (error instanceof GoogleToolError && isRevisionConflict(error)) {
      throw new GoogleToolError(
        "invalid_argument",
        `The ${what} is no longer at the revision you read (or that revision ID is not valid), so nothing was changed. Read it again with ${readTool} and retry with its new revisionId.`,
        error.httpStatus,
      );
    }
    throw error;
  }
}

export interface RestCommentPost {
  content?: string;
  author?: { displayName?: string; anonymous?: boolean };
  deleted?: boolean;
}

export interface RestCommentThread {
  commentId?: string;
  anchorId?: string;
  status?: string;
  plainTextQuote?: string;
  headPost?: RestCommentPost;
  replies?: RestCommentPost[];
}

function postLine(post: RestCommentPost): string {
  if (post.deleted) return "(deleted)";
  const author = post.author?.displayName || (post.author?.anonymous ? "Anonymous" : "Unknown author");
  return `${author}: ${(post.content ?? "").replace(/\s*\n\s*/g, " ").trim()}`;
}

export function renderComments(threads: readonly RestCommentThread[], where: (thread: RestCommentThread) => string | undefined): string[] {
  return threads.map((thread) => {
    const place = where(thread);
    const quote = thread.plainTextQuote ? ` on "${thread.plainTextQuote.replace(/\s+/g, " ").trim()}"` : "";
    const state = thread.status === "RESOLVED" ? " (resolved)" : "";
    const head = `- ${thread.headPost ? postLine(thread.headPost) : "(no text)"}${quote}${place ? ` [${place}]` : ""}${state}`;
    return [head, ...(thread.replies ?? []).map((reply) => `  - ${postLine(reply)}`)].join("\n");
  });
}

export function plural(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}
