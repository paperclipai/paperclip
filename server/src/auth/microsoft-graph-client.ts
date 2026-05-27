// Microsoft Graph app-only client for the daily group reconciler
// (BLO-6295 piece D, reconciliation cadence: signin + daily background).
//
// Auth: client_credentials grant against the paperclip-prod Entra app
// (appId from MICROSOFT_CLIENT_ID env). The app has Group.Read.All
// app-permission granted with admin consent in the blockcast.net tenant.
//
// Token caching: tokens are valid 1h; we cache with a 60s safety margin.
// Hot path is the daily reconciler — at-most 1 mint per run is cheap.

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface CachedToken {
  value: string;
  expiresAt: number;
}

let cachedToken: CachedToken | null = null;
let pendingMint: Promise<string | null> | null = null;

async function mintGraphToken(): Promise<string | null> {
  const tenantId = process.env.MICROSOFT_TENANT_ID?.trim();
  const clientId = process.env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET?.trim();
  if (!tenantId || !clientId || !clientSecret) return null;

  if (pendingMint) return pendingMint;
  pendingMint = (async () => {
    try {
      const url = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
      const body = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      });
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        console.error(`microsoft-graph: token mint failed ${res.status} ${await res.text().catch(() => "")}`);
        return null;
      }
      const data = (await res.json()) as { access_token: string; expires_in: number };
      cachedToken = {
        value: data.access_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      };
      return data.access_token;
    } catch (err) {
      console.error("microsoft-graph: token mint exception:", err);
      return null;
    } finally {
      pendingMint = null;
    }
  })();
  return pendingMint;
}

async function getGraphToken(): Promise<string | null> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  return mintGraphToken();
}

/**
 * Return the security group IDs (`@odata.type === '#microsoft.graph.group'`)
 * that the given Entra user is a member of, including transitive (nested)
 * memberships. Returns `null` on Graph errors or when the user isn't found
 * in Entra — callers treat `null` as "skip this user" and try again on the
 * next cycle.
 *
 * userPrincipalName is the Microsoft email — same value better-auth stores
 * as `account.accountId` on the Microsoft account row.
 */
export async function getEntraUserGroupIds(
  userPrincipalName: string,
): Promise<string[] | null> {
  const token = await getGraphToken();
  if (!token) return null;
  try {
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(userPrincipalName)}/transitiveMemberOf?$select=id&$top=200`;
    const res = await fetch(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      console.error(`microsoft-graph: transitiveMemberOf ${userPrincipalName} failed ${res.status}`);
      return null;
    }
    const data = (await res.json()) as {
      value?: Array<{ id?: string; "@odata.type"?: string }>;
    };
    if (!Array.isArray(data.value)) return [];
    return data.value
      .filter((m) => m["@odata.type"] === "#microsoft.graph.group")
      .map((m) => m.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch (err) {
    console.error(`microsoft-graph: transitiveMemberOf exception for ${userPrincipalName}:`, err);
    return null;
  }
}

/** Test-only: clear the cached token between runs. */
export function _resetGraphToken(): void {
  cachedToken = null;
}
