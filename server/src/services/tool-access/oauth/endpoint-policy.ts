import { checkOAuthEndpointUrl, oauthEndpointUrlRejectionMessage, type OAuthEndpointKind, type OAuthEndpointUrlRejection } from "@paperclipai/shared";
import { HttpError } from "../../../errors.js";
import { originOf, isSmokeLabOAuthUrl } from "./metadata.js";

export function createOAuthEndpointPolicy(allowPrivateRemoteEndpoints: () => boolean) {
  /**
   * OAuth endpoint scheme/transport gate (PAP-17099).
   *
   * Every OAuth endpoint Paperclip acts on is attacker-influenced: discovered
   * metadata, a `WWW-Authenticate` hint, a pasted config, or a gallery default.
   * The authorization endpoint is the sharpest one because it is handed to the
   * operator's browser as a top-level navigation, so `javascript:`/`data:` there
   * would run in the board's origin. `checkOAuthEndpointUrl` is the single place
   * that decides; loopback `http:` is accepted only under the same
   * local-development policy that governs private remote endpoints, and
   * Paperclip's own origin is exempt from the transport rule because a
   * first-party endpoint (the smoke-lab fixture) is served exactly as the board
   * itself is.
   */
  function oauthEndpointRejected(
    kind: OAuthEndpointKind,
    reason: OAuthEndpointUrlRejection,
  ): HttpError {
    return new HttpError(422, oauthEndpointUrlRejectionMessage(kind, reason), {
      code: `oauth_${kind}_endpoint_rejected`,
      reason,
    });
  }

  /**
   * Origins that are Paperclip itself: this deployment's configured public URL,
   * plus the callback origin of the request in hand when there is one. Only the
   * plaintext-transport rule is relaxed for these.
   */
  function firstPartyOrigins(candidate?: string | null): string[] {
    const configured =
      process.env.PAPERCLIP_PUBLIC_URL?.trim() ||
      process.env.PAPERCLIP_AUTH_PUBLIC_BASE_URL?.trim() ||
      process.env.BETTER_AUTH_URL?.trim() ||
      process.env.BETTER_AUTH_BASE_URL?.trim() ||
      null;
    return [originOf(candidate), originOf(configured)].filter(
      (origin): origin is string => Boolean(origin),
    );
  }

  /**
   * Origins for which the plaintext-transport rule is relaxed when checking
   * `value`. Adds the smoke-lab fixture's own origin, because that provider is
   * mounted on this deployment's own routes — `assertNotSmokeLabOAuthEndpoints`
   * is what stops any other connection from claiming those paths — and a smoke
   * run may be driven against a deployment served over plaintext HTTP.
   */
  function insecureTransportExemptions(
    value: unknown,
    candidate?: string | null,
  ): string[] {
    const origins = firstPartyOrigins(candidate);
    if (typeof value === "string" && isSmokeLabOAuthUrl(value)) {
      const origin = originOf(value);
      if (origin) origins.push(origin);
    }
    return origins;
  }

  /** Throws unless `value` is an endpoint Paperclip may use (and navigate to). */
  function assertOAuthEndpointUrl(
    kind: OAuthEndpointKind,
    value: unknown,
    options: { firstPartyOrigin?: string | null } = {},
  ): string {
    const check = checkOAuthEndpointUrl(value, {
      allowInsecureLoopback: allowPrivateRemoteEndpoints(),
      allowInsecureOrigins: insecureTransportExemptions(
        value,
        options.firstPartyOrigin,
      ),
    });
    if (!check.ok) throw oauthEndpointRejected(kind, check.reason);
    return check.url;
  }

  /**
   * Discovery variant: an unusable endpoint is dropped rather than thrown, so a
   * second advertised authorization server (or a later metadata candidate) still
   * gets a chance. Rejections are recorded in `rejections`; discovery raises the
   * first one only if it ends up with nothing safe to use, so the operator sees
   * *why* instead of a bare "does not advertise OAuth sign in".
   */
  function safeOAuthEndpointUrl(
    kind: OAuthEndpointKind,
    value: unknown,
    rejections: HttpError[],
    firstPartyOrigin?: string | null,
  ): string | null {
    if (value === null || value === undefined || value === "") return null;
    const check = checkOAuthEndpointUrl(value, {
      allowInsecureLoopback: allowPrivateRemoteEndpoints(),
      allowInsecureOrigins: insecureTransportExemptions(
        value,
        firstPartyOrigin,
      ),
    });
    if (check.ok) return check.url;
    if (check.reason !== "missing")
      rejections.push(oauthEndpointRejected(kind, check.reason));
    return null;
  }

  return { assertOAuthEndpointUrl, safeOAuthEndpointUrl };
}
