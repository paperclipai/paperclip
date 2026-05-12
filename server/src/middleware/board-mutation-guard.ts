import type { Request, RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3100",
  "http://127.0.0.1:3100",
];

function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function trustedOriginsForRequest(req: Request) {
  const origins = new Set(DEFAULT_DEV_ORIGINS.map((value) => value.toLowerCase()));
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || req.header("host")?.trim();
  if (host) {
    origins.add(`http://${host}`.toLowerCase());
    origins.add(`https://${host}`.toLowerCase());
  }
  // Behind some reverse proxies the Host / X-Forwarded-Host header may
  // not match the public URL (for example when TLS terminates at the
  // edge and the inbound Host is an internal service name). Trust the
  // explicitly-configured PAPERCLIP_PUBLIC_URL when it's set.
  const publicUrl = parseOrigin(process.env.PAPERCLIP_PUBLIC_URL?.trim());
  if (publicUrl) origins.add(publicUrl);
  return origins;
}

function hostnameOf(hostHeader: string): string | null {
  // Strip port. Handle ipv6 bracket notation: "[::1]:34521" → "::1".
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith("[")) {
    const closing = trimmed.indexOf("]");
    if (closing === -1) return null;
    return trimmed.slice(1, closing).toLowerCase();
  }
  const colon = trimmed.indexOf(":");
  return (colon === -1 ? trimmed : trimmed.slice(0, colon)).toLowerCase();
}

function isLoopbackHost(hostHeader: string): boolean {
  // Strict allowlist of canonical loopback spellings. Variants like
  // "localhost." (FQDN trailing dot), "::1%lo" (ipv6 zone identifier), or
  // "127.000.000.001" (leading-zero IPv4) are deliberately rejected: the
  // narrow contract is "the request claims one of the canonical loopback
  // identities" and exotic variants should authenticate explicitly rather
  // than be normalized into the trust set.
  const host = hostnameOf(hostHeader);
  if (!host) return false;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function isLoopbackRemoteAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const normalized = remoteAddress.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1";
}

function isTrustedBoardMutationRequest(req: Request) {
  const allowedOrigins = trustedOriginsForRequest(req);
  const originHeader = req.header("origin");
  const refererHeader = req.header("referer");
  const origin = parseOrigin(originHeader);
  if (origin && allowedOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(refererHeader);
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  // Header-absent fallback: if neither Origin nor Referer is present at all,
  // treat the request as trusted only when the peer address is loopback and
  // the literal Host header also resolves to loopback (127.0.0.1 / localhost / ::1).
  //
  // X-Forwarded-Host is intentionally NOT considered here: it is a client-
  // supplied proxy header and would let an external caller bypass the gate
  // by spoofing "X-Forwarded-Host: localhost". The Host header is also
  // client-sent, so it is only a secondary constraint; req.socket.remoteAddress
  // is the trust boundary.
  //
  // The fallback covers Playwright API contexts (pwRequest.newContext targets
  // the e2e server on 127.0.0.1) and any local script running on the host.
  //
  // Reverse-proxy deployments without a browser (e.g. server-to-server scripts
  // hitting the public URL with Origin / Referer stripped) are intentionally
  // NOT covered here — they should use a board API key (req.actor.source ===
  // "board_key", short-circuited above) or an authenticated agent identity.
  // The PAPERCLIP_PUBLIC_URL escape hatch still applies via the Origin /
  // Referer check above for real browsers.
  //
  // Anti-spoof intent is preserved on two axes:
  // 1. A request that DOES send Origin or Referer with a mismatched value
  //    (handled above) still 403s — the fallback only fires when both are
  //    absent.
  // 2. An arbitrary Host pointing at any non-loopback hostname is rejected.
  //    The earlier "any Host" form would have let internal-network clients
  //    bypass CSRF by simply omitting browser headers; loopback-only is the
  //    narrowed boundary.
  if (originHeader === undefined && refererHeader === undefined) {
    const host = req.header("host")?.trim();
    if (host && isLoopbackHost(host) && isLoopbackRemoteAddress(req.socket?.remoteAddress)) return true;
  }

  return false;
}

function isIssueMutationRequest(req: Request) {
  const path = (req.originalUrl || req.url || "").split("?")[0] ?? "";
  return /^\/api(?:\/[^/]+)*\/issues(?:\/|$)/.test(path);
}

export function boardMutationGuard(): RequestHandler {
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Local-trusted browser requests are still the board UI. Local scripts that
    // mutate issue threads must authenticate or carry a resolvable run id so
    // they cannot silently write audit records as "local-board".
    if (req.actor.source === "local_implicit") {
      if (isIssueMutationRequest(req) && !isTrustedBoardMutationRequest(req)) {
        res.status(403).json({
          error: "Issue mutation requires trusted browser origin or authenticated actor",
        });
        return;
      }
      next();
      return;
    }

    // Board bearer keys are explicit non-browser credentials.
    if (req.actor.source === "board_key") {
      next();
      return;
    }

    if (!isTrustedBoardMutationRequest(req)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
