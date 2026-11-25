import { and, eq, ne } from "drizzle-orm";
import { connectionGrants, toolConnections, type Db } from "@paperclipai/db";
import { aiConnectionMetadataSchema, type ManagedGoogleRevocationOutcome } from "@paperclipai/shared";
import { antigravityAccountDigest } from "./native-runtime/antigravity-runner-credentials.js";

export const GOOGLE_OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const ANTIGRAVITY_REVOCATION_PROFILE = "antigravity.subscription";
export const ANTIGRAVITY_REVOCATION_MAX_ATTEMPTS = 8;
export const ANTIGRAVITY_UNKNOWN_ACCOUNT = "unknown";

export type GoogleTokenRevoker = (refreshToken: string, timeoutMs: number) => Promise<ManagedGoogleRevocationOutcome>;

export function isAntigravitySubscriptionConnection(
  connection: Pick<typeof toolConnections.$inferSelect, "connectionPurpose" | "config">,
): boolean {
  if (connection.connectionPurpose !== "ai") return false;
  const metadata = aiConnectionMetadataSchema.safeParse(connection.config?.ai);
  return metadata.success && metadata.data.provider === "google" && metadata.data.method === "subscription";
}

export function antigravityRefreshToken(credential: string): string | null {
  try {
    const value = JSON.parse(credential) as { refresh_token?: unknown };
    return typeof value?.refresh_token === "string" && value.refresh_token.length > 0 ? value.refresh_token : null;
  } catch {
    return null;
  }
}

export function antigravityRevocationSubject(accountLabel: unknown): string {
  return typeof accountLabel === "string" && accountLabel.trim().length > 0
    ? antigravityAccountDigest(accountLabel)
    : ANTIGRAVITY_UNKNOWN_ACCOUNT;
}

export async function antigravityAccountStillConnected(
  db: Db,
  companyId: string,
  subject: string,
  excludeGrantIds: readonly string[] = [],
): Promise<boolean> {
  const rows = await db
    .select({
      id: connectionGrants.id,
      providerTenant: connectionGrants.providerTenant,
      connectionPurpose: toolConnections.connectionPurpose,
      config: toolConnections.config,
    })
    .from(connectionGrants)
    .innerJoin(toolConnections, and(
      eq(toolConnections.id, connectionGrants.connectionId),
      eq(toolConnections.companyId, connectionGrants.companyId),
    ))
    .where(and(
      eq(connectionGrants.companyId, companyId),
      ne(connectionGrants.status, "revoked"),
      ne(toolConnections.status, "archived"),
    ));
  return rows.some((row) => {
    if (excludeGrantIds.includes(row.id) || !isAntigravitySubscriptionConnection(row)) return false;
    const other = antigravityRevocationSubject(row.providerTenant?.name);
    return subject === ANTIGRAVITY_UNKNOWN_ACCOUNT || other === ANTIGRAVITY_UNKNOWN_ACCOUNT || other === subject;
  });
}

export const revokeGoogleRefreshToken: GoogleTokenRevoker = async (refreshToken, timeoutMs) => {
  let response: Response;
  try {
    response = await fetch(GOOGLE_OAUTH_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(Math.max(1, Math.floor(timeoutMs))),
    });
  } catch {
    return "provider_revocation_failed";
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return "revoked";
  }
  if (response.status === 400) {
    const body = await response.json().catch(() => null) as { error?: unknown } | null;
    if (body?.error === "invalid_token") return "revoked";
    return "revocation_not_available";
  }
  await response.body?.cancel().catch(() => undefined);
  if (response.status === 429 || response.status >= 500) return "provider_revocation_failed";
  return "revocation_not_available";
};
