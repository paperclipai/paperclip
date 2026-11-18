import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { DRAFT_VIEWS, readDraftBodies, readDraftRequest, toMcpDraft, type DraftView, type GmailRestDraftFull } from "./get-draft.js";
import type { MessageBodies } from "./message.js";
import { mapLimited, unlessMissing } from "./parallel.js";
import { draftSchema } from "./schemas.js";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "./search-threads.js";

const args = z.object({
  pageSize: z.number().int().positive().optional(),
  pageToken: z.string().max(2048).optional(),
  query: z.string().max(4096).optional(),
  view: z.enum(DRAFT_VIEWS).optional(),
});
export type ListDraftsArgs = z.infer<typeof args>;

interface GmailDraftList {
  drafts?: Array<{ id?: string }>;
  nextPageToken?: string;
}

export function listDraftsRequest(input: ListDraftsArgs): GoogleRequest {
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: "/gmail/v1/users/me/drafts",
    query: {
      q: input.query?.trim() || undefined,
      maxResults: Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      pageToken: input.pageToken || undefined,
    },
  };
}

export function draftIds(list: GmailDraftList): string[] {
  return (list.drafts ?? []).map((draft) => draft.id).filter((id): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(id));
}

export function listDraftsResult(list: GmailDraftList, drafts: Array<GmailRestDraftFull | null>, input: ListDraftsArgs, bodies?: MessageBodies): CallToolResult {
  return structuredResult(compact({
    drafts: drafts.filter((draft): draft is GmailRestDraftFull => draft !== null).map((draft) => toMcpDraft(draft, input.view, bodies)),
    nextPageToken: list.nextPageToken || undefined,
  }));
}

async function readDrafts(ids: string[], view: DraftView | undefined, http: GoogleHttp): Promise<Array<GmailRestDraftFull | null>> {
  return mapLimited(ids, (draftId) => unlessMissing(http.send<GmailRestDraftFull>(readDraftRequest(draftId, view))));
}

export const listDrafts = defineTool({
  definition: {
    name: "list_drafts",
    description: "Lists the signed-in user's Gmail drafts one page at a time, optionally filtered by a Gmail search query. Returns recipients, subject and bodies by default.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", description: "Optional. Most drafts to return. Default 20, maximum 50." },
        pageToken: { type: "string", description: "Optional. The nextPageToken from a previous call. Leave empty for the first page." },
        query: { type: "string", description: "Optional. A Gmail search query (for example `to:user@example.com newer_than:7d`)." },
        view: {
          type: "string",
          enum: [...DRAFT_VIEWS],
          description: "Optional. DRAFT_VIEW_FULL (default) returns recipients, subject and bodies. DRAFT_VIEW_METADATA_ONLY leaves out the subject and bodies.",
        },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        drafts: { type: "array", items: draftSchema, description: "The drafts on this page." },
        nextPageToken: { type: "string", description: "Pass as pageToken to get the next page. Present only when there are more results." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  args,
  whenTooLarge: "Ask for fewer drafts with a smaller pageSize, or use view DRAFT_VIEW_METADATA_ONLY, then read single drafts with get_draft.",
  async run(input, http) {
    const list = await http.send<GmailDraftList>(listDraftsRequest(input));
    const drafts = await readDrafts(draftIds(list), input.view, http);
    const bodies = await readDraftBodies(drafts.filter((draft): draft is GmailRestDraftFull => draft !== null), input.view, http);
    return listDraftsResult(list, drafts, input, bodies);
  },
});
