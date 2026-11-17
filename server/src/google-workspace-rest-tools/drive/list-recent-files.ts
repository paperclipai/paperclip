import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
  snippetArgs,
  snippetInputs,
  type RestFileList,
} from "./file.js";

const args = z.object({ orderBy: z.string().max(64).optional(), pageSize: pageSizeArg, pageToken: pageTokenArg, ...snippetArgs });
export type ListRecentFilesArgs = z.infer<typeof args>;

const ORDERS: Readonly<Record<string, string>> = {
  recency: "recency desc",
  lastModified: "modifiedTime desc",
  lastModifiedByMe: "modifiedByMeTime desc",
};

export function recentOrder(value: string | undefined): string {
  return (value && Object.hasOwn(ORDERS, value) ? ORDERS[value] : undefined) ?? ORDERS.recency!;
}

export function listRecentFilesRequest(input: ListRecentFilesArgs): GoogleRequest {
  return {
    method: "GET",
    host: DRIVE_HOST,
    path: `${DRIVE_BASE}/files`,
    query: {
      q: "trashed = false",
      orderBy: recentOrder(input.orderBy),
      pageSize: pageSize(input.pageSize),
      pageToken: input.pageToken,
      fields: listFields(),
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    },
  };
}

export function listRecentFilesResult(list: RestFileList): CallToolResult {
  return structuredResult(listResult(list));
}

export const listRecentFiles = defineTool({
  definition: {
    name: "list_recent_files",
    description: "Lists the user's Drive files, most recent first, leaving out trashed files. orderBy recency (default) sorts by the latest of the file's times; lastModified by the last change by anyone; lastModifiedByMe by the user's last change. Another value falls back to recency. Default page size 10, at most 100. Pass nextPageToken as pageToken for more. Returns no content snippets.",
    inputSchema: {
      type: "object",
      properties: {
        orderBy: { type: "string", description: "Optional. recency (default), lastModified or lastModifiedByMe." },
        pageSize: { type: "integer", description: "Optional. Files per page. Default 10, at most 100." },
        pageToken: { type: "string", description: "Optional. nextPageToken from the previous page." },
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
    return listRecentFilesResult(await http.send<RestFileList>(listRecentFilesRequest(input)));
  },
});
