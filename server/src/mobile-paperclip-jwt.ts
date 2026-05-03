import { createHmac, timingSafeEqual } from "node:crypto";

export interface MobilePaperclipJwtClaims {
  sub: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  email?: string;
  pcRole?: string;
  jti?: string;
}

const JWT_ALGORITHM = "HS256";

const DEFAULT_ISSUER = "mobile-paperclip";
const DEFAULT_AUDIENCE = "paperclip-server";

interface MobileJwtConfig {
  secret: string;
  issuer: string;
  audience: string;
}

function loadConfig(): MobileJwtConfig | null {
  const secret = process.env.MOBILE_PAPERCLIP_JWT_SECRET?.trim();
  if (!secret) return null;
  return {
    secret,
    issuer: process.env.MOBILE_PAPERCLIP_JWT_ISSUER?.trim() || DEFAULT_ISSUER,
    audience: process.env.MOBILE_PAPERCLIP_JWT_AUDIENCE?.trim() || DEFAULT_AUDIENCE,
  };
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(secret: string, signingInput: string) {
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

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function isMobilePaperclipJwtConfigured(): boolean {
  return loadConfig() !== null;
}

export function verifyMobilePaperclipJwt(token: string): MobilePaperclipJwtClaims | null {
  if (!token) return null;
  const config = loadConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(config.secret, signingInput);
  if (!safeCompare(signature, expectedSig)) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || iat === null || exp === null) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : null;
  const audience = typeof claims.aud === "string" ? claims.aud : null;
  if (issuer !== config.issuer) return null;
  if (audience !== config.audience) return null;

  return {
    sub,
    iat,
    exp,
    iss: issuer,
    aud: audience,
    ...(typeof claims.email === "string" ? { email: claims.email } : {}),
    ...(typeof claims.pcRole === "string" ? { pcRole: claims.pcRole } : {}),
    ...(typeof claims.jti === "string" ? { jti: claims.jti } : {}),
  };
}
