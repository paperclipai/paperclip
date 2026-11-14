/**
 * Pure parsers for Codex `auth.json` payloads. They take already-read bytes or
 * parsed JSON and touch no filesystem state, so they live apart from the
 * managed-home seeding and reconciliation logic in `codex-home.ts`.
 */

// Co-change notice: this function's logic is mirrored by parseAuth in
// packages/adapter-utils/src/sandbox-managed-runtime.ts (buildCodexAuthMergeDecisionScript).
// If the auth format changes (new shape, renamed field), update both sites together.
export function hasUsableAuthPayload(authPayload: unknown): boolean {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return false;
  }

  const parsedPayload = authPayload as Record<string, unknown>;
  const apiKey = parsedPayload.OPENAI_API_KEY;
  if (typeof apiKey === "string" && apiKey.trim().length > 0) {
    return true;
  }

  const tokens = parsedPayload.tokens;
  if (tokens !== null && typeof tokens === "object" && !Array.isArray(tokens)) {
    const parsedTokens = tokens as Record<string, unknown>;
    const accountId = parsedTokens.account_id;
    const hasAccountId = typeof accountId === "string" && accountId.trim().length > 0;
    const hasTokenMaterial = ["id_token", "access_token", "refresh_token"].some((key) => {
      const value = parsedTokens[key];
      return typeof value === "string" && value.trim().length > 0;
    });
    if (hasAccountId && hasTokenMaterial) return true;
  }

  return false;
}

export function readApiKeyFromAuthPayload(authPayload: unknown): string | null {
  if (authPayload === null || typeof authPayload !== "object" || Array.isArray(authPayload)) {
    return null;
  }
  const raw = (authPayload as Record<string, unknown>).OPENAI_API_KEY;
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
}

/**
 * The `last_refresh` timestamp of an auth.json payload, in epoch milliseconds,
 * or null when the bytes are unreadable or carry no parseable timestamp. This is
 * the same freshness field the shared merge decision predicate
 * (`codex-auth-merge-decision.cjs`) compares, read the same way, so the seeding
 * heal below and the credential writers agree on what "fresher" means.
 */
export function readAuthLastRefreshMs(bytes: Buffer | null): number | null {
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const raw = (parsed as Record<string, unknown>).last_refresh;
  const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
