import { createPrivateKey, sign as cryptoSign } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { GitHubInstallationToken, GitHubSyncConfig } from "./types.js";
import { GITHUB_TOKEN_REFRESH_MARGIN_MS } from "../constants.js";

let cachedToken: GitHubInstallationToken | null = null;

function base64UrlEncode(data: Buffer | Uint8Array): string {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf.toString("base64url");
}

function createJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = JSON.stringify({ alg: "RS256", typ: "JWT" });
  const payload = JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId });

  const headerB64 = base64UrlEncode(Buffer.from(header));
  const payloadB64 = base64UrlEncode(Buffer.from(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  // createPrivateKey handles both PKCS#1 (RSA PRIVATE KEY) and PKCS#8 (PRIVATE KEY)
  const key = createPrivateKey(privateKeyPem);
  const signature = cryptoSign("sha256", Buffer.from(signingInput), key);

  return `${signingInput}.${base64UrlEncode(signature)}`;
}

export async function getInstallationToken(
  ctx: PluginContext,
  config: GitHubSyncConfig,
): Promise<string> {
  // Return cached token if still valid
  if (
    cachedToken &&
    cachedToken.expiresAt.getTime() - Date.now() > GITHUB_TOKEN_REFRESH_MARGIN_MS
  ) {
    return cachedToken.token;
  }

  const privateKey = await ctx.secrets.resolve(config.privateKeySecret);
  const jwt = await createJwt(config.githubAppId, privateKey);

  const response = await ctx.http.fetch(
    `https://api.github.com/app/installations/${config.githubInstallationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "Paperclip-GitHub-Sync/0.1.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get installation token: ${response.status} ${body}`);
  }

  const data = (await response.json()) as { token: string; expires_at: string };
  cachedToken = {
    token: data.token,
    expiresAt: new Date(data.expires_at),
  };

  ctx.logger.info("GitHub installation token refreshed", {
    expiresAt: data.expires_at,
  });

  return cachedToken.token;
}

export function clearTokenCache(): void {
  cachedToken = null;
}
