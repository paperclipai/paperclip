import { z } from "zod";

export const setUserDelegateSchema = z.object({
  agentId: z.string().guid(),
}).strict();

export type SetUserDelegate = z.infer<typeof setUserDelegateSchema>;
