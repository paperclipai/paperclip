import { z } from "zod";

/**
 * The identity block the server hands the browser for Plain chat email
 * authentication. Every field derives from the authenticated user row —
 * the route accepts no caller-supplied identity input.
 *
 * `emailHash` is an HMAC-SHA256 of the email, computed server-side with the
 * Plain chat authentication secret. It is a bearer credential for the
 * customer's chat identity: the browser must hand it to the Plain widget and
 * nothing else — no logging, no storage, no shared caches.
 */
export const supportChatCustomerSchema = z.object({
  email: z.string().min(1),
  emailHash: z.string().regex(/^[0-9a-f]{64}$/),
  // Optional display name; Plain accepts `fullName` on `customerDetails`.
  fullName: z.string().min(1).nullable(),
  // The Paperclip user id, passed as Plain's `externalId` so support threads
  // associate with an opaque internal identifier rather than product content.
  externalId: z.string().min(1),
});

export type SupportChatCustomer = z.infer<typeof supportChatCustomerSchema>;

/**
 * The customer's *current* Paperclip company, echoed back only after the
 * server has validated the signed-in user's membership in it. It exists so
 * support threads can carry which company the customer was working in — a
 * Plain **tenant** in vendor terms (Plain "companies" are derived from the
 * customer's email domain and are not set by us).
 */
export const supportChatCompanySchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  // Stable matching key for upserts and organization renames. This is not
  // the email-domain company; the widget uses the native tenantId below.
  tenantExternalId: z.string().min(1).nullable(),
  // Plain ID returned by the server-side upsert; used directly by the widget.
  tenantId: z.string().min(1).nullable().default(null),
});

export type SupportChatCompany = z.infer<typeof supportChatCompanySchema>;

/**
 * Response of `GET /api/support-chat/session`. The route answers 404 when
 * support chat is not enabled on this instance, so this schema only describes
 * the enabled shape.
 *
 * `customer` is `null` when the server cannot attest a verified identity
 * (missing HMAC secret, unverified email). The widget still mounts and Plain's
 * own email verification flow covers identity instead.
 */
export const supportChatSessionSchema = z.object({
  provider: z.literal("plain"),
  appId: z.string().min(1),
  // True when the instance enabled support chat through the development-only
  // opt-in rather than the Cloud-managed signal. Surfaced so preview evidence
  // can name the mode honestly; carries no extra capability.
  devPreview: z.boolean(),
  customer: supportChatCustomerSchema.nullable(),
  // `null` when the request named no company, the user is not a member of the
  // named company, or the company does not exist — all deliberately the same
  // shape, so the response never confirms foreign company ids.
  company: supportChatCompanySchema.nullable(),
});

export type SupportChatSession = z.infer<typeof supportChatSessionSchema>;
