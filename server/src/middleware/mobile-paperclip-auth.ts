import type { Request, RequestHandler } from "express";
import { verifyMobilePaperclipJwt, type MobilePaperclipJwtClaims } from "../mobile-paperclip-jwt.js";

declare module "express-serve-static-core" {
  interface Request {
    mobilePaperclipClaims?: MobilePaperclipJwtClaims;
  }
}

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

function extractHostname(req: Request): string | null {
  const forwardedHost = req.header("x-forwarded-host")?.split(",")[0]?.trim();
  const hostHeader = req.header("host")?.trim();
  const raw = forwardedHost || hostHeader;
  if (!raw) return null;
  try {
    return new URL(`http://${raw}`).hostname.trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

export interface MobilePaperclipAuthGuardOptions {
  enabled: boolean;
  publicHostnames: Set<string>;
}

export function isMobilePaperclipPublicHostname(
  hostname: string | null,
  publicHostnames: Set<string>,
): boolean {
  if (!hostname) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return false;
  return publicHostnames.has(hostname);
}

export function mobilePaperclipAuthGuard(opts: MobilePaperclipAuthGuardOptions): RequestHandler {
  if (!opts.enabled || opts.publicHostnames.size === 0) {
    return (_req, _res, next) => next();
  }

  return (req, res, next) => {
    const hostname = extractHostname(req);
    if (!isMobilePaperclipPublicHostname(hostname, opts.publicHostnames)) {
      next();
      return;
    }

    const authHeader = req.header("authorization");
    if (!authHeader?.toLowerCase().startsWith("bearer ")) {
      res.status(401).json({ error: "Missing bearer token on public hostname." });
      return;
    }

    const token = authHeader.slice("bearer ".length).trim();
    const claims = verifyMobilePaperclipJwt(token);
    if (!claims) {
      res.status(401).json({ error: "Invalid mobile-paperclip token." });
      return;
    }

    req.mobilePaperclipClaims = claims;
    req.actor = {
      type: "board",
      userId: `mobile-paperclip:${claims.sub}`,
      userName: "Mobile Paperclip",
      userEmail: claims.email ?? null,
      isInstanceAdmin: claims.pcRole === "instance_admin",
      source: "mobile_paperclip_jwt",
    };

    next();
  };
}
