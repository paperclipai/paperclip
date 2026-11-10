import type { AiConnectionAccountIdentity, AiConnectionMetadata } from "@paperclipai/shared";
import { readUsage } from "./ai-connection-usage.js";

type Observation = Omit<AiConnectionAccountIdentity, "connectionId" | "grantId">;
type FailureCode = NonNullable<Observation["errorCode"]>;
const messages: Record<FailureCode, string> = {
  unsupported: "Account details are not available for this sign-in method.",
  connection_unavailable: "Reconnect or enable this connection to check its account details.",
  authentication_required: "Reconnect this account to check its account details.",
  permission_denied: "Anthropic did not permit this connection to read the account email.",
  rate_limited: "Anthropic limited this account check. Try again later.",
  provider_unavailable: "Could not read the account details. Try again later.",
  invalid_response: "Anthropic did not return an account email.",
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown): string | null => typeof value === "string" && value.trim().length > 0
  && value.length <= 254 && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;

/** Never uses ambient CLI identity or exposes provider IDs, tokens, or raw responses. */
export async function probeAiAccountIdentity(
  metadata: AiConnectionMetadata,
  credential: string,
  request: typeof fetch = fetch,
): Promise<Observation> {
  const base = { checkedAt: new Date().toISOString(), accountLabel: null, organizationLabel: null };
  if (metadata.provider !== "anthropic" || metadata.method !== "subscription" || metadata.routing) {
    return { ...base, status: "unavailable", errorCode: "unsupported", message: messages.unsupported };
  }
  try {
    const profile = await readUsage("https://api.anthropic.com/api/oauth/profile", {
      Authorization: `Bearer ${credential}`, "anthropic-beta": "oauth-2025-04-20",
    }, request);
    const accountLabel = label(object(profile.account).email);
    if (!accountLabel || !/^[^\s@/\\]+@[^\s@/\\]+\.[^\s@/\\]+$/.test(accountLabel)) {
      return { ...base, status: "unavailable", errorCode: "invalid_response", message: messages.invalid_response };
    }
    return { ...base, status: "available", accountLabel, organizationLabel: label(object(profile.organization).name) };
  } catch (error) {
    const code = object(error).code;
    const errorCode: FailureCode = typeof code === "string" && Object.hasOwn(messages, code) ? code as FailureCode : "provider_unavailable";
    return { ...base, status: errorCode === "authentication_required" || errorCode === "permission_denied" ? "unavailable" : "error", errorCode, message: messages[errorCode] };
  }
}
