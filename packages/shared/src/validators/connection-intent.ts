import { z } from "zod";

export const connectionsSearchInputSchema = z.object({
  query: z.string().trim().max(200).default(""),
}).strict();

export const connectionRequestInputSchema = z.object({
  service: z.string().trim().min(1).max(120),
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
