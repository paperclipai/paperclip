import { assertPublicRemoteHttpEndpoint, type RemoteHttpEndpointLookup } from "../../remote-http-endpoint-guard.js";

/**
 * Where this deployment publishes its Client ID Metadata Document. The document's
 * own URL is the `client_id` Paperclip presents, so this path is a stable part of
 * the deployment's public contract with every authorization server that has seen
 * it — changing it invalidates existing CIMD registrations.
 */
export const OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH =
  "/api/tools/oauth/client-metadata";

/**
 * Resolve the URL Paperclip would use as a CIMD client id, but only when its
 * hostname is not known to resolve into a private network.
 *
 * An authorization server fetches this URL from outside Paperclip's network and
 * will normally apply an SSRF guard. Tailscale/MagicDNS names are HTTPS but
 * resolve into 100.64.0.0/10, so presenting one as a client id can only produce
 * an `invalid_client` response. A local DNS failure remains inconclusive because
 * split-horizon public DNS may still let the authorization server resolve it.
 */
export async function resolveOAuthClientIdMetadataDocumentUrl(
  redirectUri: string,
  lookup?: RemoteHttpEndpointLookup,
): Promise<string | null> {
  try {
    const parsed = new URL(redirectUri);
    if (parsed.protocol !== "https:") return null;
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const isLoopback =
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname);
    if (isLoopback) return null;
    const metadataUrl = new URL(
      OAUTH_CLIENT_ID_METADATA_DOCUMENT_PATH,
      parsed.origin,
    ).toString();
    try {
      await assertPublicRemoteHttpEndpoint(
        new URL(metadataUrl),
        { allowPrivateNetwork: false, lookup },
        (message, code) => Object.assign(new Error(message), { code }),
      );
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "remote_http_private_endpoint"
      ) {
        return null;
      }
    }
    return metadataUrl;
  } catch {
    return null;
  }
}

/**
 * Paperclip's client metadata for CIMD (RFC 7591 metadata, served rather than
 * registered). Only the callback for this deployment appears in it, so an
 * authorization server that fetches it can see exactly one legal redirect target.
 */
export function oauthClientIdMetadataDocument(input: {
  clientId: string;
  redirectUri: string;
}): Record<string, unknown> {
  return {
    client_id: input.clientId,
    client_name: `Paperclip (${new URL(input.redirectUri).host})`,
    client_uri: new URL("/", input.clientId).toString(),
    redirect_uris: [input.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "web",
  };
}
