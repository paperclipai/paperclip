import { oauthConfig, sameOAuthIssuer } from "./metadata.js";
import type { OAuthProviderEndpoints } from "./types.js";
import { createHash, randomBytes } from "node:crypto";
import { toolConnections } from "@paperclipai/db";
import type { AppDefinition } from "@paperclipai/shared";
import { badRequest, unprocessable } from "../../../errors.js";

export function assertOAuthRedirectConstraints(
  app: AppDefinition | null,
  redirectUri: string,
) {
  if (app?.redirectConstraints !== "https-or-loopback-http") return;
  let redirect: URL;
  try {
    redirect = new URL(redirectUri);
  } catch {
    throw unprocessable("OAuth callback URL is invalid", {
      code: "oauth_redirect_uri_invalid",
    });
  }
  const hostname = redirect.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (
    redirect.protocol === "https:" ||
    (redirect.protocol === "http:" && isLoopback)
  )
    return;
  throw unprocessable(
    "This provider requires an HTTPS or loopback origin. Configure TLS before connecting.",
    {
      code: "oauth_redirect_origin_unsupported",
      redirectConstraints: app.redirectConstraints,
      docsPath: "docs/deploy",
    },
  );
}

/**
 * Validate RFC 9207 `iss` on the authorization callback.
 *
 * When an authorization server returns `iss`, it must name the same issuer the
 * authorization request was bound to. A mismatch means the code came back from a
 * different server than the one we sent the user to — the mix-up attack RFC 9207
 * exists to stop — so the code is refused rather than exchanged. An absent `iss`
 * is tolerated: it is optional, and many deployed servers omit it.
 */
export function assertOAuthCallbackIssuer(
  connection: typeof toolConnections.$inferSelect,
  endpoints: OAuthProviderEndpoints,
  iss: string | null | undefined,
) {
  const returnedIssuer = typeof iss === "string" ? iss.trim() : "";
  if (!returnedIssuer) return;
  const oauth = oauthConfig(connection);
  const expectedIssuer =
    typeof oauth.expectedIssuer === "string" && oauth.expectedIssuer.trim()
      ? oauth.expectedIssuer.trim()
      : (endpoints.issuer ?? null);
  if (!expectedIssuer) return;
  if (sameOAuthIssuer(returnedIssuer, expectedIssuer)) return;
  throw badRequest(
    "Sign-in came back from an unexpected server. Start the connection again.",
    {
      code: "oauth_issuer_mismatch",
    },
  );
}

export function randomOauthToken(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

export function base64UrlSha256(input: string) {
  return createHash("sha256").update(input).digest("base64url");
}
