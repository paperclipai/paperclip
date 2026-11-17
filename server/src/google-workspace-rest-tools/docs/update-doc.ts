import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { allowedKinds, assertRequestKinds, batchRequestArg, fileIdArg, MAX_BATCH_REQUESTS, refusedKinds, revisionIdArg, sendBatchUpdate } from "../documents-shared.js";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { DOCS_HOST, documentPath, type RestBatchUpdateResponse } from "./document.js";
import { DOCS_REQUEST_KINDS } from "./request-kinds.js";

const WRITE_MODES = ["WRITE_MODE_UNSPECIFIED", "EDIT", "SUGGEST"] as const;

const args = z.object({
  documentId: fileIdArg("Docs document"),
  requests: z.array(batchRequestArg).min(1).max(MAX_BATCH_REQUESTS),
  writeControl: z.object({
    requiredRevisionId: revisionIdArg.optional(),
    targetRevisionId: z.string().max(1024).optional(),
    writeMode: z.enum(WRITE_MODES).optional(),
  }).optional(),
});
export type UpdateDocArgs = z.infer<typeof args>;

export function updateDocRequest(input: UpdateDocArgs): GoogleRequest {
  assertRequestKinds(input.requests, DOCS_REQUEST_KINDS);
  const control = input.writeControl ?? {};
  if (control.targetRevisionId !== undefined) {
    throw new GoogleToolError("invalid_argument", "targetRevisionId is not supported because it can apply edits to a newer version than the one you read. Pass writeControl.requiredRevisionId from read_doc instead. Nothing was changed.");
  }
  if (!control.requiredRevisionId) {
    throw new GoogleToolError("invalid_argument", "writeControl.requiredRevisionId is required: pass content.revisionId from read_doc, so the edit is applied only to the version you read. Nothing was changed.");
  }
  return {
    method: "POST",
    host: DOCS_HOST,
    path: `${documentPath(input.documentId)}:batchUpdate`,
    body: {
      requests: input.requests,
      writeControl: compact({ requiredRevisionId: control.requiredRevisionId, writeMode: control.writeMode }),
    },
  };
}

export function updateDocResult(response: RestBatchUpdateResponse): CallToolResult {
  return structuredResult({ replies: response.replies ?? [], writeControl: response.writeControl ?? {} });
}

export const updateDoc = defineTool({
  definition: {
    name: "update_doc",
    description: [
      "Edits an existing Google Doc with a list of Docs API batchUpdate requests (for example insertText, deleteContentRange, replaceAllText, updateTextStyle, updateParagraphStyle, createParagraphBullets, insertTable or insertInlineImage), and returns one reply per request.",
      "Requests are applied in the order given, all or none: if any request is invalid, nothing is changed.",
      "The requests can delete or replace content in this one document, for example deleteContentRange, replaceAllText or deleteTab. This tool cannot create, delete, move, copy or share files.",
      `Accepted request kinds: ${allowedKinds(DOCS_REQUEST_KINDS).join(", ")}. Images are accepted only from links outside drive.google.com and docs.google.com.`,
      `Refused because they read another file: ${refusedKinds(DOCS_REQUEST_KINDS).join(", ")}. Any other kind is refused too.`,
      "Each request sees the document as changed by the requests before it, so indices after an insertion or deletion move. When making several edits by index from one read_doc result, order them from the highest index to the lowest.",
      "Indices are UTF-16 code units from read_doc's content.tabs; the body starts at index 1. Pass tabId in locations and ranges to edit a tab other than the first.",
      "writeControl.requiredRevisionId is required: pass content.revisionId from read_doc. If the document changed since, nothing is changed and you must read it again. The new revision ID is returned in writeControl.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Required. The ID of the document to edit." },
        requests: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Required. Docs API batchUpdate requests, each an object with exactly one request kind, such as {\"insertText\": {\"text\": \"Hello\", \"location\": {\"index\": 1}}}. See https://developers.google.com/workspace/docs/api/reference/rest/v1/documents/request.",
        },
        writeControl: {
          type: "object",
          properties: {
            requiredRevisionId: { type: "string", description: "Required. The revisionId from read_doc. If the document is no longer at this revision, nothing is changed." },
            targetRevisionId: { type: "string", description: "Not supported: use requiredRevisionId." },
            writeMode: { type: "string", enum: [...WRITE_MODES], description: "Optional. EDIT (default) applies the changes; SUGGEST makes them as suggestions." },
          },
          required: ["requiredRevisionId"],
          description: "Required. Controls how the edit is applied.",
        },
      },
      required: ["documentId", "requests", "writeControl"],
    },
    outputSchema: {
      type: "object",
      properties: {
        replies: { type: "array", items: { type: "object" }, description: "One reply per request, in order; some are empty." },
        writeControl: { type: "object", description: "The document's revision after the edit, as requiredRevisionId." },
      },
      required: ["replies", "writeControl"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  args,
  async run(input, http) {
    const request = updateDocRequest(input);
    return updateDocResult(await sendBatchUpdate<RestBatchUpdateResponse>(http, request, "document", "read_doc"));
  },
});
