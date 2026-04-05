import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as z from "zod";
import type { Db } from "@paperclipai/db";
import { authUsers, authVerifications, instanceUserRoles } from "@paperclipai/db";

export const PIXELPORT_HANDOFF_CONTRACT_VERSION = "p1-v1";
const PIXELPORT_HANDOFF_ISSUER = "pixelport-launchpad";
const PIXELPORT_HANDOFF_AUDIENCE = "paperclip-runtime";
const PIXELPORT_HANDOFF_MAX_CLOCK_SKEW_SECONDS = 60;
const PIXELPORT_HANDOFF_EMAIL_DOMAIN = "pixelport.handoff.local";
const HANDOFF_JTI_PREFIX = "pixelport-handoff-jti";

const handoffQuerySchema = z.object({
  handoff_token: z.string().optional(),
  token: z.string().optional(),
  next: z.string().optional(),
});

export interface PixelportHandoffPayload {
  v: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  source: string;
  user_id: string;
  tenant_id: string;
  tenant_slug: string;
  tenant_status: string;
  tenant_plan: string;
}

export type PixelportHandoffVerifyErrorCode =
  | "missing-secret"
  | "invalid-format"
  | "invalid-signature"
  | "invalid-payload"
  | "invalid-claims"
  | "expired";

export type PixelportHandoffVerifyResult =
  | { ok: true; payload: PixelportHandoffPayload }
  | { ok: false; code: PixelportHandoffVerifyErrorCode };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function parsePayload(rawPayload: unknown): PixelportHandoffPayload | null {
  if (!isRecord(rawPayload)) return null;

  const v = readString(rawPayload, "v");
  const iss = readString(rawPayload, "iss");
  const aud = readString(rawPayload, "aud");
  const iat = readNumber(rawPayload, "iat");
  const exp = readNumber(rawPayload, "exp");
  const jti = readString(rawPayload, "jti");
  const source = readString(rawPayload, "source");
  const userId = readString(rawPayload, "user_id");
  const tenantId = readString(rawPayload, "tenant_id");
  const tenantSlug = readString(rawPayload, "tenant_slug");
  const tenantStatus = readString(rawPayload, "tenant_status");
  const tenantPlan = readString(rawPayload, "tenant_plan");

  if (!v || !iss || !aud || iat === null || exp === null || !jti || !source || !userId || !tenantId || !tenantSlug || !tenantStatus || !tenantPlan) {
    return null;
  }

  return {
    v,
    iss,
    aud,
    iat,
    exp,
    jti,
    source,
    user_id: userId,
    tenant_id: tenantId,
    tenant_slug: tenantSlug,
    tenant_status: tenantStatus,
    tenant_plan: tenantPlan,
  };
}

function safeCompare(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const actualBytes = Buffer.from(actual, "utf8");
  if (expectedBytes.length !== actualBytes.length) return false;
  return timingSafeEqual(expectedBytes, actualBytes);
}

function resolveNowEpochSeconds(nowEpochSeconds?: number): number {
  if (typeof nowEpochSeconds === "number" && Number.isFinite(nowEpochSeconds)) {
    return Math.floor(nowEpochSeconds);
  }
  return Math.floor(Date.now() / 1000);
}

function buildHandoffJtiMarkerId(jti: string): string {
  return `${HANDOFF_JTI_PREFIX}:${jti}`;
}

async function consumeHandoffJti(
  db: Db,
  jti: string,
  expiresAtEpochSeconds: number,
  nowEpochSeconds: number,
): Promise<boolean> {
  const markerId = buildHandoffJtiMarkerId(jti);
  const now = new Date(nowEpochSeconds * 1000);
  const expiresAt = new Date(expiresAtEpochSeconds * 1000);

  const existing = await db
    .select({ id: authVerifications.id, expiresAt: authVerifications.expiresAt })
    .from(authVerifications)
    .where(eq(authVerifications.id, markerId))
    .then((rows) => rows[0] ?? null);

  if (existing && existing.expiresAt.getTime() > now.getTime()) {
    return false;
  }

  if (existing) {
    await db.delete(authVerifications).where(eq(authVerifications.id, markerId));
  }

  try {
    await db.insert(authVerifications).values({
      id: markerId,
      identifier: markerId,
      value: "consumed",
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  } catch {
    return false;
  }
}

export function verifyPixelportHandoffToken(
  token: string,
  handoffSecret: string | undefined,
  nowEpochSeconds?: number,
): PixelportHandoffVerifyResult {
  const secret = handoffSecret?.trim() ?? "";
  if (!secret) {
    return { ok: false, code: "missing-secret" };
  }

  const trimmedToken = token.trim();
  const [encodedPayload, encodedSignature, ...rest] = trimmedToken.split(".");
  if (!encodedPayload || !encodedSignature || rest.length > 0) {
    return { ok: false, code: "invalid-format" };
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(encodedPayload)
    .digest("base64url");

  if (!safeCompare(expectedSignature, encodedSignature)) {
    return { ok: false, code: "invalid-signature" };
  }

  let parsedPayload: unknown;
  try {
    const decodedPayload = Buffer.from(encodedPayload, "base64url").toString("utf8");
    parsedPayload = JSON.parse(decodedPayload);
  } catch {
    return { ok: false, code: "invalid-payload" };
  }

  const payload = parsePayload(parsedPayload);
  if (!payload) {
    return { ok: false, code: "invalid-payload" };
  }

  const now = resolveNowEpochSeconds(nowEpochSeconds);
  if (payload.iss !== PIXELPORT_HANDOFF_ISSUER || payload.aud !== PIXELPORT_HANDOFF_AUDIENCE) {
    return { ok: false, code: "invalid-claims" };
  }
  if (payload.v !== PIXELPORT_HANDOFF_CONTRACT_VERSION) {
    return { ok: false, code: "invalid-claims" };
  }
  if (payload.exp <= now) {
    return { ok: false, code: "expired" };
  }
  if (payload.iat > now + PIXELPORT_HANDOFF_MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, code: "invalid-claims" };
  }
  if (payload.iat <= 0 || payload.exp <= payload.iat) {
    return { ok: false, code: "invalid-claims" };
  }

  return { ok: true, payload };
}

function sanitizeEmailLocalPart(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return `u-${createHash("sha256").update("pixelport").digest("hex").slice(0, 24)}`;
  }
  const normalized = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized) {
    return `u-${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
  }
  return normalized.slice(0, 48);
}

function deriveUserName(payload: PixelportHandoffPayload): string {
  const slug = payload.tenant_slug.trim();
  if (!slug) return "PixelPort User";
  return `PixelPort ${slug}`;
}

function deriveUserEmail(payload: PixelportHandoffPayload): string {
  return `${sanitizeEmailLocalPart(payload.user_id)}@${PIXELPORT_HANDOFF_EMAIL_DOMAIN}`;
}

function resolveHandoffToken(query: z.infer<typeof handoffQuerySchema>): string | null {
  const token = query.handoff_token ?? query.token;
  if (!token) return null;
  const trimmed = token.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveNextPath(rawNext: string | undefined): string {
  const candidate = rawNext?.trim();
  if (!candidate) return "/";
  if (!candidate.startsWith("/")) return "/";
  if (candidate.startsWith("//")) return "/";
  return candidate;
}

function jsonError(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function ensurePixelportBoardPrincipal(
  db: Db,
  payload: PixelportHandoffPayload,
): Promise<typeof authUsers.$inferSelect> {
  return db.transaction(async (tx) => {
    const now = new Date();
    let user = await tx
      .select()
      .from(authUsers)
      .where(eq(authUsers.id, payload.user_id))
      .then((rows) => rows[0] ?? null);

    if (!user) {
      await tx.insert(authUsers).values({
        id: payload.user_id,
        name: deriveUserName(payload),
        email: deriveUserEmail(payload),
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      });
      user = await tx
        .select()
        .from(authUsers)
        .where(eq(authUsers.id, payload.user_id))
        .then((rows) => rows[0] ?? null);
      if (!user) {
        throw new Error("Failed to create handoff user");
      }
    }

    const roleRow = await tx
      .select({ id: instanceUserRoles.id })
      .from(instanceUserRoles)
      .where(and(eq(instanceUserRoles.userId, payload.user_id), eq(instanceUserRoles.role, "instance_admin")))
      .then((rows) => rows[0] ?? null);
    if (!roleRow) {
      await tx.insert(instanceUserRoles).values({
        userId: payload.user_id,
        role: "instance_admin",
      });
    }

    return user;
  });
}

export function pixelportHandoffPlugin(db: Db): BetterAuthPlugin {
  return {
    id: "pixelport-handoff",
    endpoints: {
      pixelportHandoff: createAuthEndpoint(
        "/pixelport/handoff",
        {
          method: "GET",
          query: handoffQuerySchema,
          requireHeaders: true,
        },
        async (ctx) => {
          const handoffToken = resolveHandoffToken(ctx.query);
          if (!handoffToken) {
            return jsonError(400, "handoff_token is required");
          }

          const verification = verifyPixelportHandoffToken(handoffToken, process.env.PAPERCLIP_HANDOFF_SECRET);
          if (!verification.ok) {
            if (verification.code === "missing-secret") {
              return jsonError(503, "PAPERCLIP_HANDOFF_SECRET is not configured");
            }
            return jsonError(401, `Invalid handoff token (${verification.code})`);
          }
          const now = resolveNowEpochSeconds();
          if (!(await consumeHandoffJti(db, verification.payload.jti, verification.payload.exp, now))) {
            return jsonError(401, "Invalid handoff token (replayed)");
          }

          const user = await ensurePixelportBoardPrincipal(db, verification.payload);
          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) {
            return jsonError(401, "Failed to create auth session");
          }

          await setSessionCookie(ctx, { session, user });

          const redirectPath = resolveNextPath(ctx.query.next);
          throw ctx.redirect(new URL(redirectPath, ctx.context.baseURL).toString());
        },
      ),
    },
  };
}
