import { z } from "zod";

/**
 * Payload an agent submits to request a credential (`request_credential`, issue #4).
 * Describes WHAT it needs by name and reason only. The secret value is never in the
 * payload: the board provides it at approval time via the provide-credential endpoint,
 * which stores it encrypted in company_secrets and binds it to the agent's run env.
 */
export const requestCredentialSchema = z.object({
  // The environment variable the agent will read at run time (e.g. STRIPE_SECRET_KEY).
  envKey: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Z][A-Z0-9_]*$/, "envKey must be an UPPER_SNAKE_CASE environment variable name"),
  // The service/provider this credential is for (e.g. "stripe", "github").
  service: z.string().trim().min(1).max(120),
  // Optional access scope the agent needs (e.g. "read+write payments").
  scope: z.string().trim().max(300).optional(),
  reason: z.string().trim().min(1).max(2000),
  // Exact steps + direct links for the board to obtain this credential, so the human
  // does not have to go hunting (e.g. "Go to https://dashboard.stripe.com/apikeys,
  // create a restricted key with ...; paste it here"). URLs are made clickable in the UI.
  howToObtain: z.string().trim().max(4000).optional(),
  // A self-contained prompt the board can hand to a browser-driving agent (e.g. Claude
  // for Chrome) so IT performs the acquisition in the browser and returns the value.
  // The human is just the courier: copy prompt -> paste into the browser agent -> paste
  // the returned value back into Provide & approve.
  browserAgentPrompt: z.string().trim().max(6000).optional(),
});
export type RequestCredential = z.infer<typeof requestCredentialSchema>;

/** The board-supplied secret value, posted to the provide-credential endpoint. */
export const provideCredentialSchema = z.object({
  value: z.string().min(1).max(8000),
  decisionNote: z.string().trim().max(2000).optional(),
});
export type ProvideCredential = z.infer<typeof provideCredentialSchema>;
