import { z } from "zod";

/**
 * Connect a Cloudflare account by API token (embedded mail, phase 0). The token
 * is validated against the Cloudflare API and stored as a company secret; only
 * the secret id is persisted on the connection row.
 */
export const connectCloudflareSchema = z.object({
  apiToken: z.string().trim().min(1).max(400),
  // Optional: pin a specific Cloudflare account; otherwise resolved from the token.
  cfAccountId: z.string().trim().max(120).optional(),
});
export type ConnectCloudflare = z.infer<typeof connectCloudflareSchema>;

/**
 * Attach an existing domain (a zone the connected account already owns) and
 * configure its mail DNS. Domain registration is out of scope for V1.
 */
export const attachDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(
      /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i,
      "Must be a valid domain name",
    ),
});
export type AttachDomain = z.infer<typeof attachDomainSchema>;

/** Create an email address on an attached domain (phase 1). */
export const createMailAddressSchema = z.object({
  domainId: z.string().uuid(),
  // The local part (before @). Use "*" for a catch-all address.
  localPart: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^(\*|[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)$/i, "Invalid local part"),
  kind: z.enum(["mailbox", "alias", "catch_all"]).optional(),
  // Owning agent (company-level create only; null/omitted = company-shared).
  agentId: z.string().uuid().nullable().optional(),
});
export type CreateMailAddress = z.infer<typeof createMailAddressSchema>;

/** Send (or reply to) an email from one of the agent's addresses (phase 2). */
export const sendEmailSchema = z
  .object({
    fromAddressId: z.string().uuid(),
    to: z.array(z.string().email()).min(1).max(20),
    cc: z.array(z.string().email()).max(20).optional(),
    subject: z.string().max(998).optional(),
    text: z.string().max(100_000).optional(),
    html: z.string().max(200_000).optional(),
    inReplyTo: z.string().max(998).optional(),
  })
  .refine((d) => Boolean(d.text || d.html), { message: "Provide a text or html body" });
export type SendEmail = z.infer<typeof sendEmailSchema>;

/** Inbox listing query (phase 1). */
export const mailInboxQuerySchema = z.object({
  since: z.string().datetime().optional(),
  status: z.enum(["received", "read"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
export type MailInboxQuery = z.infer<typeof mailInboxQuerySchema>;
