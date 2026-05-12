import type { RegisteredProvider } from "./types.js";

const TIMEOUT_MS = 10_000;

export interface RevokeUpstreamInput {
  provider: RegisteredProvider;
  accessToken?: string;
  refreshToken?: string;
}

/**
 * Best-effort RFC 7009 token revocation against an upstream provider.
 *
 * - No-op if the provider has no `endpoints.revoke` configured.
 * - No-op if neither token is provided.
 * - Prefers revoking the refresh token (which implicitly revokes derived
 *   access tokens too, per RFC 7009 §2.1).
 * - Substitutes `{client_id}` placeholder in the URL.
 * - Supports the default RFC 7009 form POST plus GitHub-style DELETE + JSON
 *   revocation for providers that set `revokeMethod: delete-json`.
 *
 * Throws on non-2xx upstream responses; callers (e.g. the disconnect route)
 * should catch and log so local cleanup proceeds either way.
 */
export async function revokeUpstreamToken(
  input: RevokeUpstreamInput,
): Promise<void> {
  const revokeUrl = input.provider.config.endpoints.revoke;
  if (!revokeUrl) return;
  if (!input.accessToken && !input.refreshToken) return;

  const url = revokeUrl.replace("{client_id}", input.provider.clientId);
  const revokeMethod = input.provider.config.revokeMethod ?? "post-form";

  if (revokeMethod === "delete-json") {
    const token = input.accessToken ?? input.refreshToken;
    if (!token) return;
    const credentials = Buffer.from(
      `${input.provider.clientId}:${input.provider.clientSecret}`,
    ).toString("base64");
    const res = await fetch(url, {
      method: "DELETE",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${credentials}`,
      },
      body: JSON.stringify({ access_token: token }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`upstream revoke failed: ${res.status}`);
    }
    return;
  }

  const body = new URLSearchParams();
  if (input.refreshToken) {
    body.set("token", input.refreshToken);
    body.set("token_type_hint", "refresh_token");
  } else if (input.accessToken) {
    body.set("token", input.accessToken);
    body.set("token_type_hint", "access_token");
  }

  const credentials = Buffer.from(
    `${input.provider.clientId}:${input.provider.clientSecret}`,
  ).toString("base64");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${credentials}`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`upstream revoke failed: ${res.status}`);
  }
}
