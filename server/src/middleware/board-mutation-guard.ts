import type { Request, RequestHandler } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const DEFAULT_DEV_ORIGINS = [
  "http://localhost:3100",
  "http://127.0.0.1:3100",
];

/** Static trusted origins built from config at startup — NOT from per-request headers. */
let staticTrustedOrigins: Set<string> | null = null;

export function initBoardMutationTrustedOrigins(allowedHostnames: string[], publicUrl?: string) {
  const origins = new Set(DEFAULT_DEV_ORIGINS.map((v) => v.toLowerCase()));
  for (const hostname of allowedHostnames) {
    origins.add(`http://${hostname}`.toLowerCase());
    origins.add(`https://${hostname}`.toLowerCase());
    // Include with port for common cases
    origins.add(`http://${hostname}:3100`.toLowerCase());
    origins.add(`https://${hostname}:3100`.toLowerCase());
  }
  if (publicUrl) {
    const parsed = parseOrigin(publicUrl);
    if (parsed) origins.add(parsed);
  }
  staticTrustedOrigins = origins;
}

function parseOrigin(value: string | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return null;
  }
}

function trustedOriginsForRequest(_req: Request) {
  if (staticTrustedOrigins) return staticTrustedOrigins;
  // Fallback for tests or pre-init calls — use only static defaults
  return new Set(DEFAULT_DEV_ORIGINS.map((value) => value.toLowerCase()));
}

function isTrustedBoardMutationRequest(req: Request) {
  const allowedOrigins = trustedOriginsForRequest(req);
  const origin = parseOrigin(req.header("origin"));
  if (origin && allowedOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  return false;
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

    // Local-trusted mode and board bearer keys are not browser-session requests.
    // In these modes, origin/referer headers can be absent; do not block those mutations.
    if (req.actor.source === "local_implicit" || req.actor.source === "board_key") {
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
