import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fileIdArg } from "../documents-shared.js";
import { GoogleToolError } from "../errors.js";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import { DOCS_HOST, documentPath, type RestDocument } from "./document.js";
import { renderDocument, type SuggestionsView } from "./render.js";

const args = z.object({
  documentId: fileIdArg("Docs document"),
  commentsIncluded: z.boolean().optional(),
});
export type ReadDocArgs = z.infer<typeof args>;

export function readDocRequest(input: ReadDocArgs, view: SuggestionsView = "SUGGESTIONS_INLINE"): GoogleRequest {
  const comments = input.commentsIncluded && view === "SUGGESTIONS_INLINE";
  return {
    method: "GET",
    host: DOCS_HOST,
    path: documentPath(input.documentId),
    query: {
      includeTabsContent: true,
      suggestionsViewMode: view,
      ...(comments ? { commentsViewMode: "COMMENTS_VIEW_MODE_INCLUDED" } : {}),
    },
  };
}

export async function readDocument(http: GoogleHttp, input: ReadDocArgs): Promise<{ document: RestDocument; view: SuggestionsView }> {
  try {
    return { document: await http.send<RestDocument>(readDocRequest(input)), view: "SUGGESTIONS_INLINE" };
  } catch (error) {
    if (!(error instanceof GoogleToolError) || error.kind !== "permission_denied") throw error;
    return { document: await http.send<RestDocument>(readDocRequest(input, "PREVIEW_WITHOUT_SUGGESTIONS")), view: "PREVIEW_WITHOUT_SUGGESTIONS" };
  }
}

export function readDocResult(document: RestDocument, input: ReadDocArgs, view: SuggestionsView = "SUGGESTIONS_INLINE"): CallToolResult {
  const content = renderDocument(document, { commentsRequested: input.commentsIncluded === true, suggestionsView: view });
  return structuredResult({ content });
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
      "content.suggestionsViewMode says how pending suggested edits were read: SUGGESTIONS_INLINE shows them marked; when your access does not include suggestions the document is read as PREVIEW_WITHOUT_SUGGESTIONS, without them, and content.notes says so.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        documentId: { type: "string", description: "Required. The ID of the document to read: the part of its docs.google.com link after /d/." },
        commentsIncluded: { type: "boolean", description: "Optional. If true, comment threads are listed at the end of content.text. When your access does not include comments and suggestions, the document is returned without them and content.notes says so. Default: false." },
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
  whenTooLarge: "This tool cannot read part of a document. Read it without commentsIncluded if that was set, or read only its text with read_file_content.",
  async run(input, http) {
    const { document, view } = await readDocument(http, input);
    return readDocResult(document, input, view);
  },
});
