import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fileIdArg, sizedResult } from "../documents-shared.js";
import type { GoogleRequest } from "../google-http.js";
import { defineTool } from "../tool.js";
import { DOCS_HOST, documentPath, type RestDocument } from "./document.js";
import { renderDocument } from "./render.js";

const args = z.object({
  documentId: fileIdArg("Docs document"),
  commentsIncluded: z.boolean().optional(),
});
export type ReadDocArgs = z.infer<typeof args>;

export function readDocRequest(input: ReadDocArgs): GoogleRequest {
  return {
    method: "GET",
    host: DOCS_HOST,
    path: documentPath(input.documentId),
    query: {
      includeTabsContent: true,
      ...(input.commentsIncluded ? { commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED", suggestionsViewMode: "SUGGESTIONS_INLINE" } : {}),
    },
  };
}

export function readDocResult(document: RestDocument, input: ReadDocArgs): CallToolResult {
  const content = renderDocument(document, { commentsRequested: input.commentsIncluded === true });
  return sizedResult({ content }, "document", "Google Docs cannot return part of a document through this tool.");
}

export const readDoc = defineTool({
  definition: {
    name: "read_doc",
    description: [
      "Reads a Google Doc, every tab included, and returns its content.",
      "content.text is the whole document as Markdown-style text: headings start with #, list items with - or their number, tables use | cells |, links are [text](url), footnote references are [^1] with the footnote text after the body, headers and footers follow the body under [Header] and [Footer], and each tab starts with === Tab: title === when there is more than one.",
      "Items that have no text form are shown in brackets, such as [image: alt text], [equation] or [page break], and content.notes says what was left out.",
      "content.tabs gives each tab's paragraphs and tables with their startIndex and endIndex (UTF-16 code units), for use with update_doc; in a paragraph's text, every non-text item such as an image takes one index and appears as U+FFFC.",
      "content.revisionId is required by update_doc.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Required. The ID of the document to read: the part of its docs.google.com link after /d/." },
        commentsIncluded: { type: "boolean", description: "Optional. If true, comment threads are listed at the end of content.text. Default: false." },
      },
      required: ["documentId"],
    },
    outputSchema: {
      type: "object",
      properties: { content: { type: "object", description: "The document's text, structure and revision ID." } },
      required: ["content"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  args,
  async run(input, http) {
    return readDocResult(await http.send<RestDocument>(readDocRequest(input)), input);
  },
});
