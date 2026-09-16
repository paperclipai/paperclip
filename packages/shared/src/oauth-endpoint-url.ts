/**
 * Scheme/transport safety for OAuth endpoints Paperclip learned from a remote
 * server (PAP-17099).
 *
 * A generic remote MCP connection can point at any endpoint, and that endpoint
 * gets to advertise its own authorization-server metadata. The
 * `authorization_endpoint` it names is not just fetched server-side — Paperclip
 * hands it to the operator's browser as a top-level navigation, so an arbitrary
 * string there is a code-execution and open-redirect primitive:
 * `javascript:` / `data:` would run in the board's origin, and plain `http:`
 * would carry the authorization request (and the operator) over a network any
 * intermediary can rewrite.
 *
 * So every endpoint URL discovered from metadata, pasted by an operator, taken
 * from a `WWW-Authenticate` hint, or shipped as a gallery default is parsed
 * here — once, in shared code — and must be:
 *
 * - a well-formed absolute URL (anything `new URL` rejects is rejected);
 * - `https:`, or `http:` only for a loopback host under the caller's explicit
 *   local-development policy (the server passes its private-network policy, the
 *   board passes "am I myself served over plaintext HTTP");
 * - free of embedded credentials, because `https://evil.test@real.test/...`
 *   reads as the wrong origin to a human and Paperclip must not help;
 * - free of a fragment, which never survives an authorization request usefully
 *   and is a classic way to hide the effective target from a reader.
 *
 * Both the server and the board import this so a value that passes the API
 * boundary cannot fail the navigation boundary, or vice versa.
 */

export type OAuthEndpointKind = "authorization" | "token" | "registration" | "metadata";

export type OAuthEndpointUrlRejection =
  | "missing"
  | "malformed"
  | "unsupported_scheme"
  | "insecure_transport"
  | "embedded_credentials"
  | "fragment";

export interface OAuthEndpointUrlOptions {
  /**
   * Allow `http:` for loopback hosts. Only true under an explicit
   * local-development policy — never for a public deployment.
   */
  allowInsecureLoopback?: boolean;
  /**
   * Origins whose `http:` is already the operator's own trust boundary —
   * in practice just Paperclip's own deployment origin. A deployment served over
   * plaintext HTTP on a LAN address can still run its own authorization
   * endpoints (the smoke-lab fixture does), and opening Paperclip from Paperclip
   * adds no exposure the board does not already have.
   */
  allowInsecureOrigins?: string[];
}

export type OAuthEndpointUrlCheck =
  | { ok: true; url: string; host: string }
  | { ok: false; reason: OAuthEndpointUrlRejection };

/** `127.0.0.0/8` — the whole loopback range, not just `127.0.0.1`. */
function isLoopbackIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  if (!parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) return false;
  return parts[0] === "127";
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "::1") return true;
  const mapped = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) return isLoopbackIpv4(mapped[1]);
  return isLoopbackIpv4(host);
}

function normalizedOrigin(value: string): string | null {
  try {
    const origin = new URL(value).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function insecureTransportAllowed(parsed: URL, options: OAuthEndpointUrlOptions): boolean {
  if (options.allowInsecureLoopback && isLoopbackHost(parsed.hostname)) return true;
  return (options.allowInsecureOrigins ?? []).some((origin) => normalizedOrigin(origin) === parsed.origin);
}

/**
 * Is `value` an OAuth endpoint Paperclip is willing to use — and, for the
 * authorization endpoint, to navigate a browser to? Returns the normalized URL
 * and its host on success, or the specific rejection reason so callers can
 * produce an actionable message.
 */
export function checkOAuthEndpointUrl(
  value: unknown,
  options: OAuthEndpointUrlOptions = {},
): OAuthEndpointUrlCheck {
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: "missing" };
  }
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return { ok: false, reason: "unsupported_scheme" };
  }
  // A `javascript:`/`data:` URL has no host, and neither does something like
  // `http:relative` — without an authority there is no origin to trust.
  if (!parsed.hostname) return { ok: false, reason: "malformed" };
  if (parsed.protocol === "http:" && !insecureTransportAllowed(parsed, options)) {
    return { ok: false, reason: "insecure_transport" };
  }
  if (parsed.username || parsed.password) return { ok: false, reason: "embedded_credentials" };
  if (parsed.hash) return { ok: false, reason: "fragment" };
  return { ok: true, url: parsed.toString(), host: parsed.host };
}

export function isSafeOAuthEndpointUrl(value: unknown, options: OAuthEndpointUrlOptions = {}): boolean {
  return checkOAuthEndpointUrl(value, options).ok;
}

const KIND_LABELS: Record<OAuthEndpointKind, string> = {
  authorization: "sign-in",
  token: "token",
  registration: "client registration",
  metadata: "metadata",
};

/**
 * A UI-safe explanation for a rejected endpoint. Never echoes the URL, because
 * the string came from the remote server and may itself be the attack.
 */
export function oauthEndpointUrlRejectionMessage(
  kind: OAuthEndpointKind,
  reason: OAuthEndpointUrlRejection,
): string {
  const label = KIND_LABELS[kind];
  switch (reason) {
    case "missing":
      return `This server did not provide a ${label} address.`;
    case "malformed":
      return `This server's ${label} address is not a valid URL, so Paperclip stopped.`;
    case "unsupported_scheme":
      return `This server's ${label} address does not use https, so Paperclip stopped.`;
    case "insecure_transport":
      return `This server's ${label} address is not secure (https), so Paperclip stopped.`;
    case "embedded_credentials":
      return `This server's ${label} address hides a different site behind a username, so Paperclip stopped.`;
    case "fragment":
      return `This server's ${label} address is malformed for sign-in, so Paperclip stopped.`;
  }
}

/**
 * The host to show an operator before they are sent to an authorization page.
 * `null` when the value is not a usable URL — callers should be refusing to
 * navigate at that point anyway.
 */
export function oauthEndpointDisplayHost(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    return new URL(value.trim()).host || null;
  } catch {
    return null;
  }
}
