import { z } from "zod";

// emailHash is a server-generated bearer credential: never log or persist it.
export const supportChatCustomerSchema = z.object({
  email: z.string().min(1),
  emailHash: z.string().regex(/^[0-9a-f]{64}$/),
  fullName: z.string().min(1).nullable(),
});
export type SupportChatCustomer = z.infer<typeof supportChatCustomerSchema>;

// Disabled instances answer 404. No company or internal user IDs are exposed.
export const supportChatSessionSchema = z.object({
  provider: z.literal("plain"),
  appId: z.string().min(1),
  devPreview: z.boolean(),
  customer: supportChatCustomerSchema.nullable(),
});
export type SupportChatSession = z.infer<typeof supportChatSessionSchema>;
