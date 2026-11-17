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

export async function sendBatchUpdate<T>(http: GoogleHttp, request: GoogleRequest, what: string, readTool: string): Promise<T> {
  try {
    return await http.send<T>(request);
  } catch (error) {
    if (error instanceof GoogleToolError && error.httpStatus === 400 && /revision/i.test(error.message)) {
      throw new GoogleToolError(
        "invalid_argument",
        `The ${what} is no longer at the revision you read (or that revision ID is not valid), so nothing was changed. Read it again with ${readTool} and retry with its new revisionId.`,
        400,
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
