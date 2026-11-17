import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fileIdArg, readWithComments } from "../documents-shared.js";
import type { GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import { presentationPath, SLIDES_HOST, type RestPresentation } from "./presentation.js";
import { renderPresentation } from "./render.js";

const fieldPath = z.string().min(1).max(2000).regex(/^[A-Za-z0-9_.,()*/]+$/, "Must be a field mask path such as slides.pageElements(objectId,shape.text)");

const args = z.object({
  presentationId: fileIdArg("Slides presentation"),
  fields: z.array(fieldPath).max(50).optional(),
  commentsIncluded: z.boolean().optional(),
});
export type ReadPresentationArgs = z.infer<typeof args>;

export function readPresentationRequest(input: ReadPresentationArgs): GoogleRequest {
  return {
    method: "GET",
    host: SLIDES_HOST,
    path: presentationPath(input.presentationId),
    query: {
      fields: input.fields?.length ? input.fields.join(",") : undefined,
      commentsViewMode: input.commentsIncluded ? "COMMENTS_VIEW_MODE_INCLUDED" : undefined,
    },
  };
}

export function readPresentationAccessCheckRequest(input: ReadPresentationArgs): GoogleRequest {
  return { method: "GET", host: SLIDES_HOST, path: presentationPath(input.presentationId), query: { fields: "presentationId" } };
}

export const COMMENTS_UNAVAILABLE = "Comments are not available for this presentation with your access, so nothing was returned. The presentation can be read without them: call read_presentation again without commentsIncluded.";

export function readPresentationResult(presentation: RestPresentation, input: ReadPresentationArgs): CallToolResult {
  if (input.fields?.length) {
    return structuredResult({ content: presentation as Record<string, unknown> });
  }
  const content = renderPresentation(presentation, { commentsRequested: input.commentsIncluded === true });
  return structuredResult({ content });
}

export const readPresentation = defineTool({
  definition: {
    name: "read_presentation",
    description: [
      "Reads a Google Slides presentation.",
      "Without fields, content.text is every slide in order as Markdown-style text: each slide starts with ## Slide N, title placeholders start with ###, bullets keep their glyph, tables use | cells |, links are [text](url), and each slide's speaker notes follow under Speaker notes:.",
      "Items that have no text form are shown in brackets, such as [image: alt text] or [chart], and content.notes says what was left out.",
      "content.slides gives each slide's objectId and its page elements with their objectId, type and raw text (character indices for update_presentation count from 0 in that text), plus the speaker notes shape's objectId.",
      "content.revisionId is required by update_presentation.",
      "With fields, content is the Slides API presentation resource limited to those fields, as Google returns it.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        presentationId: { type: "string", description: "Required. The ID of the presentation to read: the part of its docs.google.com link after /d/." },
        fields: {
          type: "array",
          items: { type: "string" },
          description: "Optional. A field mask over the Slides API presentation resource, such as [\"revisionId\", \"slides(objectId,pageElements(objectId,shape.text))\"]. When set, content is the raw resource limited to these fields instead of the text form.",
        },
        commentsIncluded: { type: "boolean", description: "Optional. If true, comment threads are included. Needs access to comments; without it the call fails and says so. Default: false." },
      },
      required: ["presentationId"],
    },
    outputSchema: {
      type: "object",
      properties: { content: { type: "object", description: "The presentation's text, structure and revision ID, or the fields asked for." } },
      required: ["content"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  args,
  whenTooLarge: (input) => input.fields?.length ? "Ask for fewer fields." : "Pass fields to read only part of it, for example [\"slides.objectId\", \"slides.pageElements(objectId,shape.text)\"].",
  async run(input, http) {
    const plain = input.commentsIncluded ? readPresentationAccessCheckRequest(input) : undefined;
    return readPresentationResult(await readWithComments<RestPresentation>(http, readPresentationRequest(input), plain, COMMENTS_UNAVAILABLE), input);
  },
});
