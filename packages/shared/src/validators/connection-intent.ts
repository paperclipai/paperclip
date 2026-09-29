import { z } from "zod";

export const connectionsSearchInputSchema = z.object({
  query: z.string().trim().max(200).default(""),
  retryProviderChoice: z.boolean().optional().describe("Only when the user explicitly asks to reconsider a previous provider choice or decline"),
}).strict();

export const connectionRequestInputSchema = z.object({
  service: z.string().trim().min(1).max(120),
  selectionInteractionId: z.string().guid().optional(),
  targetService: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional().describe("App slug returned by search only when the user explicitly named this external provider"),
}).strict();

export const completeConnectionIntentSchema = z.object({
  connectionId: z.string().guid(),
}).strict();

export const declineConnectionIntentSchema = z.object({
  reason: z.string().trim().max(4000).optional(),
}).strict();

export type ConnectionsSearchInput = z.infer<typeof connectionsSearchInputSchema>;
export type ConnectionRequestInput = z.infer<typeof connectionRequestInputSchema>;
export type CompleteConnectionIntent = z.infer<typeof completeConnectionIntentSchema>;
export type DeclineConnectionIntent = z.infer<typeof declineConnectionIntentSchema>;
