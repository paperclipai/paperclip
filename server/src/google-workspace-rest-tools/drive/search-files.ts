import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { GoogleToolError } from "../errors.js";
import type { GoogleRequest } from "../google-http.js";
import { defineTool, structuredResult } from "../tool.js";
import {
  assertSnippetArgs,
  READ_LESS,
  DRIVE_BASE,
  DRIVE_HOST,
  fileListSchema,
  listFields,
  listResult,
  pageSize,
  pageSizeArg,
  pageTokenArg,
  richMetadataInput,
  snippetArgs,
  snippetInputs,
  type RestFileList,
} from "./file.js";
import { driveSearchQuery, MAX_QUERY_LENGTH } from "./query.js";

const args = z.object({
  query: z.string().max(MAX_QUERY_LENGTH).optional(),
  pageSize: pageSizeArg,
  pageToken: pageTokenArg,
  orderBy: z.string().max(64).optional(),
  includeRichMetadata: z.boolean().optional(),
  ...snippetArgs,
});
export type SearchFilesArgs = z.infer<typeof args>;

export function searchOrder(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const match = /^(modifiedTime|viewedByMeTime)(?:\s+(asc|desc))?$/.exec(trimmed);
  if (!match) throw new GoogleToolError("invalid_argument", "orderBy must be modifiedTime or viewedByMeTime, optionally followed by asc or desc.");
  return match[2] === "asc" ? match[1] : `${match[1]} desc`;
}

export function searchFilesRequest(input: SearchFilesArgs): GoogleRequest {
  return {
    method: "GET",
    host: DRIVE_HOST,
    path: `${DRIVE_BASE}/files`,
    query: {
      q: driveSearchQuery(input.query),
      orderBy: searchOrder(input.orderBy),
      pageSize: pageSize(input.pageSize),
      pageToken: input.pageToken,
      fields: listFields(input.includeRichMetadata === true),
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
  };
}

export function searchFilesResult(list: RestFileList, rich: boolean): CallToolResult {
  return structuredResult(listResult(list, rich));
}

const QUERY_HELP = [
  "Optional. Structured query: term operator value. Combine clauses with and, or, not and parentheses. Quote string values with single quotes; write a quote inside a value as \\' and a backslash as \\\\.",
  "Terms: title (contains, =, !=; title contains is a prefix match: 'Hello' finds HelloWorld, 'World' does not); fullText (contains; title or body text); mimeType (contains, =, !=); modifiedTime, viewedByMeTime, createdTime (<, <=, =, !=, >, >=, with an RFC 3339 time such as '2026-01-01T00:00:00Z'); parentId (=, !=; 'root' is My Drive); owner (=, !=; 'me' is the user); 'someone@example.com' in readers, 'me' in writers; visibility (=, !=: 'anyoneCanFind', 'anyoneWithLink', 'anyone', 'domainCanFind', 'domainWithLink', 'domain', 'limited'); sharedWithMe, starred, trashed (=, != with true or false).",
  "Trashed files are left out unless the query uses trashed. Not supported here: creator, sharedFrom, sharedTo, followUp, folderProperties, and visibility 'external'.",
  "Use title contains rather than title = unless the user asks for an exact title; to find a word inside a title, also try fullText contains. Put file types in mimeType clauses, not in title or fullText (for example mimeType = 'application/vnd.google-apps.presentation' for slides).",
  "Examples: title contains 'budget' and modifiedTime > '2026-01-01T00:00:00Z'; parentId = 'root'; owner = 'me' and starred = true. Empty: all files that are not trashed.",
].join(" ");

export const searchFiles = defineTool({
  definition: {
    name: "search_files",
    description: "Searches the user's Drive files with a structured query and returns one page of matching files (metadata only, no content snippets). Default page size 10, at most 100; pass nextPageToken as pageToken for more. Results may repeat across pages. When incompleteSearch is true, Google did not search everywhere and matching files may be missing. To read a file, pass its id to read_file_content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: QUERY_HELP },
        pageSize: { type: "integer", description: "Optional. Files per page. Default 10, at most 100." },
        pageToken: { type: "string", description: "Optional. nextPageToken from the previous page." },
        orderBy: { type: "string", description: "Optional. modifiedTime or viewedByMeTime, optionally followed by asc or desc (default desc). Default: Drive's own order." },
        includeRichMetadata: richMetadataInput,
        ...snippetInputs,
      },
    },
    outputSchema: fileListSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: READ_LESS.list,
  async run(input, http) {
    assertSnippetArgs(input);
    const rich = input.includeRichMetadata === true;
    return searchFilesResult(await http.send<RestFileList>(searchFilesRequest(input)), rich);
  },
});
