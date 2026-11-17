import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { allowedKinds, assertRequestKinds, batchRequestArg, fileIdArg, MAX_BATCH_REQUESTS, refusedKinds, revisionIdArg, sendBatchUpdate } from "../documents-shared.js";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import { presentationPath, SLIDES_HOST, type RestBatchUpdateResponse } from "./presentation.js";
import { SLIDES_REQUEST_KINDS } from "./request-kinds.js";

const args = z.object({
  presentationId: fileIdArg("Slides presentation"),
  requests: z.array(batchRequestArg).min(1).max(MAX_BATCH_REQUESTS),
  writeControl: z.object({ requiredRevisionId: revisionIdArg.optional() }).optional(),
});
export type UpdatePresentationArgs = z.infer<typeof args>;


export function updatePresentationRequest(input: UpdatePresentationArgs): GoogleRequest {
  assertRequestKinds(input.requests, SLIDES_REQUEST_KINDS);
  const requiredRevisionId = input.writeControl?.requiredRevisionId;
  if (!requiredRevisionId) {
    throw new GoogleToolError("invalid_argument", "writeControl.requiredRevisionId is required: pass content.revisionId from read_presentation, so the edit is applied only to the version you read. Nothing was changed.");
  }
  return {
    method: "POST",
    host: SLIDES_HOST,
    path: `${presentationPath(input.presentationId)}:batchUpdate`,
    body: { requests: input.requests, writeControl: { requiredRevisionId } },
  };
}

export function updatePresentationResult(response: RestBatchUpdateResponse): CallToolResult {
  return structuredResult({ replies: response.replies ?? [], writeControl: response.writeControl ?? {} });
}

export const updatePresentation = defineTool({
  definition: {
    name: "update_presentation",
    description: [
      "Edits an existing Google Slides presentation with a list of Slides API batchUpdate requests (for example insertText, deleteText, replaceAllText, createSlide, createShape, createTable, updateTextStyle, duplicateObject or deleteObject), and returns one reply per request.",
      "Requests are applied in the order given, all or none: if any request is invalid, nothing is changed.",
      "Each request sees the presentation as changed by the requests before it, so text indices in a shape move after an insertion or deletion in that shape. When making several edits by index in one shape from one read_presentation result, order them from the highest index to the lowest.",
      "The requests can delete or replace content in this one presentation: deleteObject removes a slide or page element, and replaceAllText and deleteText change text everywhere they match. This tool cannot create, delete, move, copy or share files.",
      `Accepted request kinds: ${allowedKinds(SLIDES_REQUEST_KINDS).join(", ")}. createVideo is accepted only with source YOUTUBE, and images only from links outside drive.google.com and docs.google.com.`,
      `Refused because they read another file: ${refusedKinds(SLIDES_REQUEST_KINDS).join(", ")}. Any other kind is refused too.`,
      "writeControl.requiredRevisionId is required: pass content.revisionId from read_presentation. If the presentation changed since, nothing is changed and you must read it again. The new revision ID is returned in writeControl.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Required. The ID of the presentation to edit." },
        requests: {
          type: "array",
          items: { type: "object", additionalProperties: true },
          description: "Required. Slides API batchUpdate requests, each an object with exactly one request kind, such as {\"insertText\": {\"objectId\": \"shape-1\", \"text\": \"Hello\", \"insertionIndex\": 0}}. See https://developers.google.com/workspace/slides/api/reference/rest/v1/presentations/request.",
        },
        writeControl: {
          type: "object",
          properties: {
            requiredRevisionId: { type: "string", description: "Required. The revisionId from read_presentation. If the presentation is no longer at this revision, nothing is changed." },
          },
          required: ["requiredRevisionId"],
          description: "Required. Controls how the edit is applied.",
        },
      },
      required: ["presentationId", "requests", "writeControl"],
    },
    outputSchema: {
      type: "object",
      properties: {
        replies: { type: "array", items: { type: "object" }, description: "One reply per request, in order; some are empty." },
        writeControl: { type: "object", description: "The presentation's revision after the edit, as requiredRevisionId." },
      },
      required: ["replies", "writeControl"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  args,
  async run(input, http) {
    const request = updatePresentationRequest(input);
    return updatePresentationResult(await sendBatchUpdate<RestBatchUpdateResponse>(http, request, "presentation", "read_presentation"));
  },
});
