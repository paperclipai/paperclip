import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";

export const DEFAULT_LABEL_PAGE_SIZE = 100;
export const MAX_LABEL_PAGE_SIZE = 500;

const args = z.object({
  pageSize: z.number().int().positive().optional(),
  pageToken: z.string().regex(/^\d{0,6}$/,"Must be the nextPageToken from a previous call").optional(),
});
export type ListLabelsArgs = z.infer<typeof args>;

interface GmailRestLabel {
  id?: string;
  name?: string;
  type?: string;
  color?: { textColor?: string; backgroundColor?: string };
}
interface GmailLabelList { labels?: GmailRestLabel[] }

export function listLabelsRequest(): GoogleRequest {
  return { method: "GET", host: "gmail.googleapis.com", path: "/gmail/v1/users/me/labels" };
}

function byNameThenId(a: { labelId: string; name: string }, b: { labelId: string; name: string }): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  if (a.labelId !== b.labelId) return a.labelId < b.labelId ? -1 : 1;
  return 0;
}

export function listLabelsResult(list: GmailLabelList, input: ListLabelsArgs): CallToolResult {
  const labels = (list.labels ?? [])
    .filter((label) => label.type === "user" && typeof label.id === "string" && typeof label.name === "string")
    .map((label) => compact({
      labelId: label.id!,
      name: label.name!,
      color: label.color?.textColor && label.color.backgroundColor
        ? { textColor: label.color.textColor, backgroundColor: label.color.backgroundColor }
        : undefined,
    }))
    .sort(byNameThenId);
  const start = Number(input.pageToken ?? "0");
  const end = start + Math.min(input.pageSize ?? DEFAULT_LABEL_PAGE_SIZE, MAX_LABEL_PAGE_SIZE);
  return structuredResult(compact({
    labels: labels.slice(start, end),
    nextPageToken: end < labels.length ? String(end) : undefined,
  }));
}

export const listLabels = defineTool({
  definition: {
    name: "list_labels",
    description: "Lists the user-defined labels in the signed-in user's Gmail with their IDs and names, sorted by name. Use the IDs with list_threads, and the names (spaces written as hyphens) with `label:` in search queries. System labels are not listed; their IDs are INBOX, SPAM, TRASH, UNREAD, STARRED, IMPORTANT, SENT, DRAFT and CHAT.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "integer", description: "Optional. Most labels to return. Default 100, maximum 500." },
        pageToken: { type: "string", description: "Optional. The nextPageToken from a previous call. Leave empty for the first page." },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        labels: {
          type: "array",
          description: "User labels.",
          items: {
            type: "object",
            properties: {
              labelId: { type: "string", description: "The label ID." },
              name: { type: "string", description: "The label's display name." },
              color: {
                type: "object",
                description: "The label's color, if set.",
                properties: {
                  textColor: { type: "string", description: "Text color, hex such as #000000." },
                  backgroundColor: { type: "string", description: "Background color, hex such as #4a86e8." },
                },
              },
            },
            required: ["labelId", "name"],
          },
        },
        nextPageToken: { type: "string", description: "Pass as pageToken to get the next page. Present only when there are more results." },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  whenTooLarge: "Ask for fewer labels with a smaller pageSize.",
  async run(input, http) {
    return listLabelsResult(await http.send<GmailLabelList>(listLabelsRequest()), input);
  },
});
