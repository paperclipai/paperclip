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
    .regex(/^(?!-)[a-z0-9-]+(\.[a-z0-9-]+)+$/i, "Must be a valid domain name"),
});
export type AttachDomain = z.infer<typeof attachDomainSchema>;
