import { z } from "zod";

const address = z.string().trim().email().max(320);
const addresses = z.array(address).max(50);
export const emailEndpointSetupSchema = z
  .object({
    assignedAgentId: z.string().uuid(),
    applicationId: z.string().uuid().optional(),
    apiKey: z.string().min(1).max(4096).optional(),
    credentialConnectionId: z.string().uuid().optional(),
    inboxId: address.optional(),
    username: z
      .string()
      .regex(/^[a-zA-Z0-9._-]+$/)
      .max(64)
      .optional(),
    domain: z.string().max(253).optional(),
    receiveMode: z.enum(["websocket", "webhook"]).default("websocket"),
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  .refine((v) => Boolean(v.apiKey) !== Boolean(v.credentialConnectionId), {
    message: "Supply an API key or a saved connection, not both",
  });

export const emailSendSchema = z
  .object({
    endpointId: z.string().uuid(),
    parentIssueId: z.string().uuid().optional(),
    conversationId: z.string().uuid().optional(),
    replyToMessageId: z.string().min(1).max(998).optional(),
    replyAll: z.boolean().default(false),
    to: addresses.optional(),
    cc: addresses.optional(),
    bcc: addresses.optional(),
    subject: z
      .string()
      .trim()
      .min(1)
      .max(998)
      .regex(/^[^\r\n]+$/)
      .optional(),
    text: z.string().trim().min(1).max(100_000),
    attachmentIds: z.array(z.string().uuid()).max(20).default([]),
    idempotencyKey: z.string().uuid(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: "custom", message });
    if (v.conversationId) {
      if (!v.replyToMessageId) fail("A reply requires its exact message ID");
      if (v.parentIssueId || v.to || v.cc || v.bcc || v.subject)
        fail(
          "Reply recipients come from the original message; use replyAll explicitly",
        );
    } else {
      if (!v.parentIssueId || !v.to?.length || !v.subject)
        fail("A new email requires a parent task, recipient, and subject");
      if (v.replyToMessageId || v.replyAll)
        fail("A new email cannot be a reply");
    }
  });
export type EmailEndpointSetupInput = z.infer<typeof emailEndpointSetupSchema>;
export type EmailSendInput = z.infer<typeof emailSendSchema>;

export const emailConnectionSchema = z
  .object({
    apiKey: z.string().min(1).max(4096),
    grantKind: z.enum(["user", "organization"]).default("user"),
    allAgents: z.boolean().default(false),
    agentIds: z.array(z.string().uuid()).max(500).default([]),
    idempotencyKey: z.string().uuid(),
  })
  .strict();
export type EmailConnectionInput = z.infer<typeof emailConnectionSchema>;
