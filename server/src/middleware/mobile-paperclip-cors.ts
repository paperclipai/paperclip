import type { RequestHandler } from "express";
import type { OriginMatcher } from "../mobile-paperclip-origins.js";

export interface MobilePaperclipCorsOptions {
  enabled: boolean;
  originMatcher: OriginMatcher;
}

const ALLOWED_METHODS = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
const ALLOWED_HEADERS = "Authorization,Content-Type,X-Paperclip-Run-Id";
const PREFLIGHT_MAX_AGE_SECONDS = 600;

export function mobilePaperclipCors(opts: MobilePaperclipCorsOptions): RequestHandler {
  if (!opts.enabled) {
    return (_req, _res, next) => next();
  }

  const matcher = opts.originMatcher;

  return (req, res, next) => {
    const requestOrigin = req.header("origin");
    const matchedOrigin = matcher.match(requestOrigin ?? null);

    if (matchedOrigin) {
      res.setHeader("Access-Control-Allow-Origin", matchedOrigin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Vary", "Origin");
      const requestedHeaders = req.header("access-control-request-headers");
      res.setHeader("Access-Control-Allow-Headers", requestedHeaders?.trim() || ALLOWED_HEADERS);
      res.setHeader("Access-Control-Allow-Methods", ALLOWED_METHODS);
      res.setHeader("Access-Control-Max-Age", String(PREFLIGHT_MAX_AGE_SECONDS));
    }

    if (req.method === "OPTIONS" && requestOrigin) {
      res.status(matchedOrigin ? 204 : 403).end();
      return;
    }

    next();
  };
}
