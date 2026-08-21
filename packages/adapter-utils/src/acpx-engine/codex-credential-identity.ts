import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const CODEX_SUBSCRIPTION_IDENTITY_DOMAIN = "paperclip:codex-subscription-account:v1\0";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Derive a non-secret, stable session identity from a Codex subscription
 * credential. OAuth token rotation for the same account produces the same
 * digest; a different account produces a different digest. Raw account and
 * token values never leave this function.
 */
export function deriveCodexSubscriptionCredentialIdentity(
  authJson: string | Buffer,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof authJson === "string" ? authJson : authJson.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const auth = parsed as Record<string, unknown>;
  if (readNonEmptyString(auth.OPENAI_API_KEY)) return null;

  const tokens = auth.tokens;
  if (tokens === null || typeof tokens !== "object" || Array.isArray(tokens)) return null;
  const tokenRecord = tokens as Record<string, unknown>;
  const accountId = readNonEmptyString(tokenRecord.account_id);
  const hasTokenMaterial = ["id_token", "access_token", "refresh_token"].some((key) =>
    readNonEmptyString(tokenRecord[key]),
  );
  if (!accountId || !hasTokenMaterial) return null;

  return createHash("sha256")
    .update(CODEX_SUBSCRIPTION_IDENTITY_DOMAIN)
    .update(accountId)
    .digest("hex");
}

export async function readCodexSubscriptionCredentialIdentity(
  codexHome: string,
): Promise<string | null> {
  const authJson = await fs.readFile(path.join(codexHome, "auth.json")).catch(() => null);
  return authJson ? deriveCodexSubscriptionCredentialIdentity(authJson) : null;
}
