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

/**
 * Resolve the host used for same-origin checks without letting a direct client
 * promote its own X-Forwarded-Host value into the trusted-origin set. Express
 * compiles the operator's TRUST_PROXY setting into `trust proxy fn`; only a
 * trusted immediate peer may supply the forwarded host.
 */
function requestHost(req: Request): string | undefined {
  const host = req.header("host")?.trim();
  const remoteAddress = req.socket?.remoteAddress;
  const trustProxy = req.app?.get("trust proxy fn") as
    | ((address: string, hop: number) => boolean)
    | undefined;

  if (
    remoteAddress
    && typeof trustProxy === "function"
    && trustProxy(remoteAddress, 0)
  ) {
    return req.header("x-forwarded-host")?.split(",")[0]?.trim() || host;
  }

  return host;
}

function trustedOriginsForRequest(req: Request) {
  const origins = new Set(DEFAULT_DEV_ORIGINS.map((value) => value.toLowerCase()));
  const host = requestHost(req);
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

/**
 * Return the browser origin only when it is the same origin Paperclip's CSRF
 * guard accepts for this request. Callers may use this as browser-reachability
 * evidence, but must still apply any protocol-specific constraints (for
 * example OAuth requiring HTTPS outside loopback).
 */
export function trustedBoardMutationOrigin(req: Request): string | null {
  const allowedOrigins = trustedOriginsForRequest(req);
  const origin = parseOrigin(req.header("origin"));
  if (origin && allowedOrigins.has(origin)) return origin;

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return refererOrigin;

  return null;
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

    // Local-trusted mode, board bearer keys, and trusted Cloud tenant calls are
    // not browser-session requests.
    // In these modes, origin/referer headers can be absent; do not block those mutations.
    if (
      req.actor.source === "local_implicit"
      || req.actor.source === "board_key"
      || req.actor.source === "cloud_tenant"
    ) {
      next();
      return;
    }

    if (!trustedBoardMutationOrigin(req)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
