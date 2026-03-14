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

function isTrustedBoardMutationRequest(req: Request, configuredOrigins: Set<string>) {
  const origin = parseOrigin(req.header("origin"));
  if (origin && configuredOrigins.has(origin)) return true;

  const refererOrigin = parseOrigin(req.header("referer"));
  if (refererOrigin && configuredOrigins.has(refererOrigin)) return true;

  return false;
}

export function boardMutationGuard(trustedOrigins?: string[]): RequestHandler {
  const allowedOrigins = new Set(
    [...DEFAULT_DEV_ORIGINS, ...(trustedOrigins ?? [])].map(o => o.toLowerCase())
  );

  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method.toUpperCase())) {
      next();
      return;
    }

    if (req.actor.type !== "board") {
      next();
      return;
    }

    // Local-trusted mode uses an implicit board actor for localhost-only development.
    // In this mode, origin/referer headers can be omitted by some clients for multipart
    // uploads; do not block those mutations.
    if (req.actor.source === "local_implicit") {
      next();
      return;
    }

    if (!isTrustedBoardMutationRequest(req, allowedOrigins)) {
      res.status(403).json({ error: "Board mutation requires trusted browser origin" });
      return;
    }

    next();
  };
}
