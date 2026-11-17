import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GoogleHttp, GoogleRequest } from "../google-http.js";
import { compact, defineTool, structuredResult } from "../tool.js";
import { parseAddressList } from "./address.js";
import { gmailId, header, isoDate, messageContent, readMessageBodies, type GmailRestMessage, type MessageBodies } from "./message.js";
import { draftSchema } from "./schemas.js";

export const DRAFT_VIEWS = ["DRAFT_VIEW_UNSPECIFIED", "DRAFT_VIEW_METADATA_ONLY", "DRAFT_VIEW_FULL"] as const;
export type DraftView = (typeof DRAFT_VIEWS)[number];
export const DRAFT_HEADERS = ["To", "Cc", "Bcc", "Subject", "Date"] as const;

const args = z.object({
  draftId: gmailId,
  view: z.enum(DRAFT_VIEWS).optional(),
});
export type GetDraftArgs = z.infer<typeof args>;

export interface GmailRestDraftFull { id?: string; message?: GmailRestMessage }

export function isFullDraftView(view: DraftView | undefined): boolean {
  return view !== "DRAFT_VIEW_METADATA_ONLY";
}

export function readDraftRequest(draftId: string, view: DraftView | undefined): GoogleRequest {
  return {
    method: "GET",
    host: "gmail.googleapis.com",
    path: `/gmail/v1/users/me/drafts/${draftId}`,
    query: isFullDraftView(view) ? { format: "full" } : { format: "metadata", metadataHeaders: DRAFT_HEADERS },
  };
}

export function toMcpDraft(draft: GmailRestDraftFull, view: DraftView | undefined, bodies: MessageBodies = new Map()): Record<string, unknown> {
  const message = draft.message ?? {};
  const payload = message.payload;
  const full = isFullDraftView(view);
  const content = full ? messageContent(payload, bodies.get(message.id ?? "")) : undefined;
  return compact({
    id: draft.id ?? "",
    subject: full ? header(payload, "Subject") ?? "" : undefined,
    threadId: message.threadId,
    toRecipients: parseAddressList(header(payload, "To")),
    ccRecipients: parseAddressList(header(payload, "Cc")),
    bccRecipients: parseAddressList(header(payload, "Bcc")),
    plaintextBody: content?.plaintextBody,
    date: isoDate(message.internalDate),
    htmlBody: content?.htmlBody,
  });
}

export async function readDraftBodies(drafts: readonly GmailRestDraftFull[], view: DraftView | undefined, http: GoogleHttp): Promise<MessageBodies | undefined> {
  if (!isFullDraftView(view)) return undefined;
  return readMessageBodies(drafts.map((draft) => draft.message ?? {}), http);
}

export function getDraftResult(draft: GmailRestDraftFull, input: GetDraftArgs, bodies?: MessageBodies): CallToolResult {
  return structuredResult(toMcpDraft({ ...draft, id: draft.id ?? input.draftId }, input.view, bodies));
}

export const getDraft = defineTool({
  definition: {
    name: "get_draft",
    description: "Gets one draft email from the signed-in user's Gmail by draft ID. Draft IDs come from list_drafts.",
    inputSchema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Required. The ID of the draft to get." },
        view: {
          type: "string",
          enum: [...DRAFT_VIEWS],
          description: "Optional. DRAFT_VIEW_FULL (default) returns recipients, subject and bodies. DRAFT_VIEW_METADATA_ONLY leaves out the subject and bodies.",
        },
      },
      required: ["draftId"],
    },
    outputSchema: draftSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  args,
  async run(input, http) {
    const draft = await http.send<GmailRestDraftFull>(readDraftRequest(input.draftId, input.view));
    return getDraftResult(draft, input, await readDraftBodies([draft], input.view, http));
  },
});
