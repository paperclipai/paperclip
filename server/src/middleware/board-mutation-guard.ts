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

function addParsedOrigin(origins: Set<string>, value: string | undefined) {
  const parsed = parseOrigin(value);
  if (parsed) origins.add(parsed);
}

function hostnameHasExplicitPort(hostname: string) {
  try {
    return new URL(`http://${hostname}`).port.length > 0;
  } catch {
    return hostname.includes(":");
  }
}

export function buildAllowedBoardOrigins(opts: {
  authPublicBaseUrl?: string;
  allowedHostnames: string[];
  serverPort: number;
}) {
  const origins = new Set<string>();
  addParsedOrigin(origins, opts.authPublicBaseUrl);

  for (const rawHostname of opts.allowedHostnames) {
    const hostname = rawHostname.trim();
    if (!hostname) continue;

    addParsedOrigin(origins, `http://${hostname}`);
    addParsedOrigin(origins, `https://${hostname}`);

    // Browser origins include the active Paperclip port during private
    // authenticated access, while allowed hostnames are usually configured
    // without an explicit port.
    if (!hostnameHasExplicitPort(hostname)) {
      addParsedOrigin(origins, `http://${hostname}:${opts.serverPort}`);
      addParsedOrigin(origins, `https://${hostname}:${opts.serverPort}`);
    }
  }

  return [...origins];
}

function trustedOriginsForRequest(req: Request, configuredOrigins: string[]) {
  const origins = new Set(DEFAULT_DEV_ORIGINS.map((value) => value.toLowerCase()));
  
  for (const o of configuredOrigins) {
    const parsed = parseOrigin(o);
    if (parsed) origins.add(parsed);
  }

  // Fallback to Host header if no explicit origins are configured
  if (configuredOrigins.length === 0) {
    const host = req.header("host")?.trim();
    if (host) {
      origins.add(`http://${host}`.toLowerCase());
      origins.add(`https://${host}`.toLowerCase());
    }
  }
  return origins;
}

function isTrustedBoardMutationRequest(req: Request, configuredOrigins: string[]) {
  const allowedOrigins = trustedOriginsForRequest(req, configuredOrigins);
  const origin = parseOrigin(req.header("origin"));
  if (origin && allowedOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && allowedOrigins.has(refererOrigin)) return true;

  return false;
}

export function boardMutationGuard(opts?: { allowedOrigins?: string[] }): RequestHandler {
  const configuredOrigins = opts?.allowedOrigins ?? [];
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

    if (!isTrustedBoardMutationRequest(req, configuredOrigins)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
