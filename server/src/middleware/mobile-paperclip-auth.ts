import type { Request, RequestHandler } from "express";
import { sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers } from "@paperclipai/db";
import { verifyMobilePaperclipJwt, type MobilePaperclipJwtClaims } from "../mobile-paperclip-jwt.js";
import { boardAuthService } from "../services/board-auth.js";

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

export interface MobilePaperclipBoardAccess {
  companyIds: string[];
  memberships: Array<{
    companyId: string;
    membershipRole?: string | null;
    status?: string;
  }>;
  isInstanceAdmin: boolean;
}

export interface MobilePaperclipBoardUser {
  id: string;
  name: string | null;
  email: string;
}

export interface MobilePaperclipAuthGuardOptions {
  enabled: boolean;
  publicHostnames: Set<string>;
  resolveUserByEmail: (email: string) => Promise<MobilePaperclipBoardUser | null>;
  resolveBoardAccess: (userId: string) => Promise<MobilePaperclipBoardAccess>;
}

export function isMobilePaperclipPublicHostname(
  hostname: string | null,
  publicHostnames: Set<string>,
): boolean {
  if (!hostname) return false;
  if (LOOPBACK_HOSTNAMES.has(hostname)) return false;
  return publicHostnames.has(hostname);
}

export function createMobilePaperclipBoardLookups(db: Db): {
  resolveUserByEmail: (email: string) => Promise<MobilePaperclipBoardUser | null>;
  resolveBoardAccess: (userId: string) => Promise<MobilePaperclipBoardAccess>;
} {
  const boardAuth = boardAuthService(db);
  return {
    resolveUserByEmail: async (email) => {
      const rows = await db
        .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
        .from(authUsers)
        .where(sql`lower(${authUsers.email}) = ${email}`);
      const row = rows[0];
      if (!row) return null;
      return { id: row.id, name: row.name ?? null, email: row.email };
    },
    resolveBoardAccess: async (userId) => {
      const access = await boardAuth.resolveBoardAccess(userId);
      return {
        companyIds: access.companyIds,
        memberships: access.memberships,
        isInstanceAdmin: access.isInstanceAdmin,
      };
    },
  };
}

export function mobilePaperclipAuthGuard(opts: MobilePaperclipAuthGuardOptions): RequestHandler {
  if (!opts.enabled || opts.publicHostnames.size === 0) {
    return (_req, _res, next) => next();
  }

  return async (req, res, next) => {
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

    const email = claims.email?.trim().toLowerCase();
    if (!email) {
      res.status(401).json({ error: "Mobile-paperclip token is missing the email claim." });
      return;
    }

    let user: MobilePaperclipBoardUser | null;
    try {
      user = await opts.resolveUserByEmail(email);
    } catch (err) {
      next(err);
      return;
    }

    if (!user) {
      res.status(401).json({ error: "No board user matches this mobile-paperclip token." });
      return;
    }

    let access: MobilePaperclipBoardAccess;
    try {
      access = await opts.resolveBoardAccess(user.id);
    } catch (err) {
      next(err);
      return;
    }

    req.mobilePaperclipClaims = claims;
    req.actor = {
      type: "board",
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      companyIds: access.companyIds,
      memberships: access.memberships,
      isInstanceAdmin: access.isInstanceAdmin || claims.pcRole === "instance_admin",
      source: "mobile_paperclip_jwt",
    };

    next();
  };
}
