import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { assertWithinCap, exportRequest, fetchContent, mediaRequest, readContentMeta, type ContentPlan } from "./content.js";
import { DRIVE_HOST, fileId, fileIdInput, filePath, GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES, READ_LESS, type RestFile } from "./file.js";

const args = z.object({ fileId, includeComments: z.boolean().optional() });
export type ReadFileContentArgs = z.infer<typeof args>;

export const SHEET_NOTE = "[Only the first sheet of this spreadsheet is shown, as CSV. Other sheets are not included.]";
export const MAX_COMMENT_PAGES = 10;
const COMMENT_PAGE_SIZE = 100;
const COMMENTABLE = new Set([GOOGLE_DOC, GOOGLE_SHEET, GOOGLE_SLIDES]);
const TEXT_APPLICATION_TYPES = new Set([
  "application/json", "application/xml", "application/javascript", "application/x-yaml", "application/yaml",
  "application/x-sh", "application/sql", "application/csv", "application/x-ndjson",
]);

export interface ReadPlan extends ContentPlan {
  prefix?: string;
}

export function readPlan(id: string, file: RestFile, maxBytes: number): ReadPlan | null {
  const mimeType = file.mimeType ?? "";
  if (mimeType === GOOGLE_DOC) return { request: exportRequest(id, "text/markdown"), contentType: "text/markdown" };
  if (mimeType === GOOGLE_SLIDES) return { request: exportRequest(id, "text/plain"), contentType: "text/plain" };
  if (mimeType === GOOGLE_SHEET) return { request: exportRequest(id, "text/csv"), contentType: "text/csv", prefix: SHEET_NOTE };
  if (mimeType.startsWith("text/") || TEXT_APPLICATION_TYPES.has(mimeType) || /\+(json|xml)$/.test(mimeType)) {
    assertWithinCap(file, READ_LESS.read, maxBytes);
    return { request: mediaRequest(id), contentType: mimeType };
  }
  return null;
}

export function decodeText(data: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, "");
  } catch {
    return null;
  }
}

export interface RestReply { id?: string; content?: string; author?: { displayName?: string }; modifiedTime?: string; deleted?: boolean }
export interface RestComment extends RestReply { resolved?: boolean; replies?: RestReply[] }
export interface RestCommentList { comments?: RestComment[]; nextPageToken?: string }

export function commentsRequest(id: string, pageToken?: string): GoogleRequest {
  return {
    method: "GET",
    host: DRIVE_HOST,
    path: `${filePath(id)}/comments`,
    query: {
      pageSize: COMMENT_PAGE_SIZE,
      pageToken,
      includeDeleted: false,
      fields: "nextPageToken,comments(id,content,author(displayName),modifiedTime,resolved,deleted,replies(id,content,author(displayName),modifiedTime,deleted))",
    },
  };
}

function toPost(post: RestReply): Record<string, unknown> {
  return compact({ postId: post.id, content: post.content ?? "", authorName: post.author?.displayName, modifiedTime: post.modifiedTime });
}

export function toCommentThread(comment: RestComment): Record<string, unknown> {
  return {
    commentId: comment.id ?? "",
    status: comment.resolved ? "RESOLVED" : "OPEN",
    headPost: toPost(comment),
    replies: (comment.replies ?? []).filter((reply) => !reply.deleted).map(toPost),
  };
}

export async function readComments(id: string, http: GoogleHttp): Promise<RestComment[]> {
  const comments: RestComment[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_COMMENT_PAGES; page += 1) {
    const list = await http.send<RestCommentList>(commentsRequest(id, pageToken));
    comments.push(...(list.comments ?? []).filter((comment) => !comment.deleted));
    pageToken = list.nextPageToken || undefined;
    if (!pageToken) return comments;
  }
  throw new GoogleToolError(
    "too_large",
    `This file has more than ${MAX_COMMENT_PAGES * COMMENT_PAGE_SIZE} comment threads, more than this tool returns. Read it without includeComments.`,
  );
}

export function readFileContentResult(file: RestFile, text: string | null, comments: RestComment[] | null, includeComments: boolean): CallToolResult {
  const commentable = COMMENTABLE.has(file.mimeType ?? "");
  return structuredResult(compact({
    fileContent: text ?? "",
    contentAnchoredComments: includeComments ? [] : undefined,
    unanchoredComments: includeComments ? (comments ?? []).map(toCommentThread) : undefined,
    textFormattingNotSupported: text === null ? true : undefined,
    commentsNotSupported: includeComments && !commentable ? true : undefined,
  }));
}

const postSchema = {
  type: "object",
  properties: {
    postId: { type: "string", description: "ID of the post." },
    content: { type: "string", description: "Text of the post." },
    authorName: { type: "string", description: "Name of the post's author." },
    modifiedTime: { type: "string", description: "When the post was last modified (RFC 3339)." },
  },
} as const;
const threadSchema = {
  type: "object",
  properties: {
    commentId: { type: "string", description: "ID of the comment thread." },
    status: { type: "string", enum: ["STATUS_UNSPECIFIED", "OPEN", "RESOLVED"], description: "Whether the thread is open or resolved." },
    headPost: { ...postSchema, description: "The first post." },
    replies: { type: "array", items: postSchema, description: "Replies, oldest first." },
  },
} as const;

export const readFileContent = defineTool({
  definition: {
    name: "read_file_content",
    description: "Returns a text version of a Drive file. Google Docs come back as Markdown, Slides as plain text, and Sheets as CSV of the first sheet only (the text says so). Text files (text/*, JSON, XML and similar) are returned as stored. Other files, such as PDFs, Office files and images, are not converted: the result has textFormattingNotSupported true and empty fileContent; use download_file_content for their bytes. The whole result has a size limit; a file too large for it is refused with an error that gives the limit, never cut short. With includeComments, the comment threads of a Google Doc, Sheet or Slides file are listed in unanchoredComments; they are not placed in the text. Get fileId from search_files or list_recent_files first.",
    inputSchema: {
      type: "object",
      properties: {
        fileId: fileIdInput("ID of the file to read."),
        includeComments: { type: "boolean", description: "Optional. Also return the file's comment threads (Google Docs, Sheets and Slides only). Default: false." },
      },
      required: ["fileId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        fileContent: { type: "string", description: "The file's text. Empty when textFormattingNotSupported is true." },
        contentAnchoredComments: { type: "array", items: threadSchema, description: "Always empty in this implementation: comments are not placed in the text." },
        unanchoredComments: { type: "array", items: threadSchema, description: "Comment threads, when includeComments is true." },
        textFormattingNotSupported: { type: "boolean", description: "True when this file type has no text version here." },
        commentsNotSupported: { type: "boolean", description: "True when includeComments is set and this file type has no comments." },
      },
      required: ["fileContent"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: READ_LESS.read,
  async run(input, http, limits) {
    const file = await readContentMeta(input.fileId, http);
    const plan = readPlan(input.fileId, file, limits.maxResultBytes);
    let text: string | null = null;
    if (plan) {
      const decoded = decodeText(await fetchContent(plan, http, READ_LESS.read, limits.maxResultBytes));
      text = decoded === null ? null : plan.prefix ? `${plan.prefix}\n${decoded}` : decoded;
    }
    const comments = input.includeComments && COMMENTABLE.has(file.mimeType ?? "") ? await readComments(input.fileId, http) : null;
    return readFileContentResult(file, text, comments, input.includeComments === true);
  },
});
