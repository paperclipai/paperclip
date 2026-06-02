/**
 * Extract the ChatGPT `account_id` for a Codex OAuth credential.
 *
 * OpenAI ties Codex entitlements (e.g. ChatGPT Pro access to gpt-5.3-codex) to a
 * `chatgpt_account_id`. That id is NOT always returned as a top-level field by
 * the device-auth flow — it is embedded in the JWT claims of the `id_token`
 * (and, at login time only, the `access_token`) under the namespaced claim
 * `https://api.openai.com/auth`. The official Codex CLI decodes the token to get
 * it; Paperclip previously only read a literal `account_id` field, so device-auth
 * logins ended up with a blank account_id and OpenAI rejected privileged models
 * with: "The '<model>' model is not supported when using Codex with a ChatGPT
 * account."
 *
 * Note: after an OAuth refresh OpenAI drops `chatgpt_account_id` from the
 * refreshed access_token, so the id_token (captured at login) is the reliable
 * source — extract and persist it once at capture time.
 */

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function accountIdFromClaims(claims: Record<string, unknown> | null): string | null {
  if (!claims) return null;
  // Preferred: the namespaced OpenAI auth claim object.
  const authClaim = claims[OPENAI_AUTH_CLAIM];
  if (authClaim && typeof authClaim === "object" && !Array.isArray(authClaim)) {
    const id = (authClaim as Record<string, unknown>).chatgpt_account_id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  // Fallbacks seen across token variants.
  const flat = claims.chatgpt_account_id;
  if (typeof flat === "string" && flat.trim()) return flat.trim();
  return null;
}

/**
 * Resolve the Codex account_id from whatever is available, in priority order:
 * an explicit account_id, then the id_token JWT, then the access_token JWT.
 * Returns null when none yields one.
 */
export function resolveCodexAccountId(input: {
  accountId?: string | null;
  idToken?: string | null;
  accessToken?: string | null;
}): string | null {
  if (typeof input.accountId === "string" && input.accountId.trim()) {
    return input.accountId.trim();
  }
  if (input.idToken) {
    const fromId = accountIdFromClaims(decodeJwtPayload(input.idToken));
    if (fromId) return fromId;
  }
  if (input.accessToken) {
    const fromAccess = accountIdFromClaims(decodeJwtPayload(input.accessToken));
    if (fromAccess) return fromAccess;
  }
  return null;
}
