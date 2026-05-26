import { createHmac, timingSafeEqual } from "node:crypto";

export interface PortalJwtClaims {
  sub: string;
  email: string;
  name?: string;
  app_access: string[];
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  org_id?: string;
  org_name?: string;
}

const JWT_ALGORITHM = "HS256";

function portalJwtSecret(): string | null {
  const secret = process.env.WBIT_PORTAL_JWT_SECRET?.trim();
  return secret && secret.length > 0 ? secret : null;
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string): string {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeCompare(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export type PortalJwtFailureReason =
  | "secret_missing"
  | "malformed"
  | "bad_signature"
  | "expired"
  | "missing_claims";

export type PortalJwtVerifyResult =
  | { ok: true; claims: PortalJwtClaims }
  | { ok: false; reason: PortalJwtFailureReason };

export function verifyPortalJwt(token: string): PortalJwtVerifyResult {
  const secret = portalJwtSecret();
  if (!secret) return { ok: false, reason: "secret_missing" };
  if (!token) return { ok: false, reason: "malformed" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return { ok: false, reason: "malformed" };

  const expectedSig = signPayload(secret, `${headerB64}.${claimsB64}`);
  if (!safeCompare(signature, expectedSig)) return { ok: false, reason: "bad_signature" };

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return { ok: false, reason: "malformed" };

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const email = typeof claims.email === "string" ? claims.email : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  const appAccessRaw = claims.app_access;
  const appAccess = Array.isArray(appAccessRaw)
    ? appAccessRaw.filter((item): item is string => typeof item === "string")
    : null;
  if (!sub || !email || !appAccess || !iat || !exp) return { ok: false, reason: "missing_claims" };

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return { ok: false, reason: "expired" };

  return {
    ok: true,
    claims: {
      sub,
      email,
      app_access: appAccess,
      iat,
      exp,
      ...(typeof claims.name === "string" ? { name: claims.name } : {}),
      ...(typeof claims.iss === "string" ? { iss: claims.iss } : {}),
      ...(typeof claims.aud === "string" ? { aud: claims.aud } : {}),
      ...(typeof claims.org_id === "string" ? { org_id: claims.org_id } : {}),
      ...(typeof claims.org_name === "string" ? { org_name: claims.org_name } : {}),
    },
  };
}

export function portalJwtConfigured(): boolean {
  return portalJwtSecret() !== null;
}
