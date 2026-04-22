import { createHmac, timingSafeEqual } from "node:crypto";

const ADMIN_OVERRIDE_ALG = "HS256";
const ADMIN_OVERRIDE_ISSUER = "paperclip-ui";
const ADMIN_OVERRIDE_AUDIENCE = "paperclip-admin-override";
const ADMIN_OVERRIDE_TTL_MAX_SECONDS = 300;
const ADMIN_OVERRIDE_REASON_MIN_LENGTH = 20;

export interface AdminOverrideJwtClaims {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  issue_id: string;
  old_status: string;
  new_status: string;
  reason: string;
}

export type AdminOverrideVerifyError =
  | "admin_override_jwt_missing"
  | "admin_override_jwt_malformed"
  | "admin_override_jwt_alg_invalid"
  | "admin_override_jwt_signature_invalid"
  | "admin_override_jwt_claims_missing"
  | "admin_override_jwt_issuer_invalid"
  | "admin_override_jwt_audience_invalid"
  | "admin_override_jwt_expired"
  | "admin_override_ttl_exceeded"
  | "admin_override_reason_invalid"
  | "admin_override_jwt_secret_missing";

export type AdminOverrideVerifyResult =
  | { ok: true; claims: AdminOverrideJwtClaims }
  | { ok: false; error: AdminOverrideVerifyError };

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function signingKey() {
  const raw = process.env.PAPERCLIP_ADMIN_OVERRIDE_JWT_KEY?.trim();
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function signPayload(secret: string, signingInput: string) {
  return createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function safeCompare(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function createAdminOverrideJwt(params: {
  subject: string;
  issueId: string;
  oldStatus: string;
  newStatus: string;
  reason: string;
  jti: string;
  ttlSeconds: number;
}): string | null {
  const keys = signingKey();
  if (!keys || keys.length === 0) return null;
  const ttl = Math.min(Math.max(1, Math.floor(params.ttlSeconds)), ADMIN_OVERRIDE_TTL_MAX_SECONDS);
  const now = Math.floor(Date.now() / 1000);
  const claims: AdminOverrideJwtClaims = {
    iss: ADMIN_OVERRIDE_ISSUER,
    aud: ADMIN_OVERRIDE_AUDIENCE,
    sub: params.subject,
    jti: params.jti,
    iat: now,
    exp: now + ttl,
    issue_id: params.issueId,
    old_status: params.oldStatus,
    new_status: params.newStatus,
    reason: params.reason,
  };
  const header = { alg: ADMIN_OVERRIDE_ALG, typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(keys[0], signingInput);
  return `${signingInput}.${signature}`;
}

export function verifyAdminOverrideJwt(token: string): AdminOverrideVerifyResult {
  if (!token) return { ok: false, error: "admin_override_jwt_missing" };
  const keys = signingKey();
  if (!keys || keys.length === 0) return { ok: false, error: "admin_override_jwt_secret_missing" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, error: "admin_override_jwt_malformed" };
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== ADMIN_OVERRIDE_ALG) {
    return { ok: false, error: "admin_override_jwt_alg_invalid" };
  }

  const signingInput = `${headerB64}.${claimsB64}`;
  const signatureOk = keys.some((key) => {
    const expected = signPayload(key, signingInput);
    return safeCompare(signature, expected);
  });
  if (!signatureOk) return { ok: false, error: "admin_override_jwt_signature_invalid" };

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return { ok: false, error: "admin_override_jwt_claims_missing" };

  const iss = isNonEmptyString(claims.iss) ? claims.iss : null;
  const aud = isNonEmptyString(claims.aud) ? claims.aud : null;
  const sub = isNonEmptyString(claims.sub) ? claims.sub : null;
  const jti = isNonEmptyString(claims.jti) ? claims.jti : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  const issueId = isNonEmptyString(claims.issue_id) ? claims.issue_id : null;
  const oldStatus = isNonEmptyString(claims.old_status) ? claims.old_status : null;
  const newStatus = isNonEmptyString(claims.new_status) ? claims.new_status : null;
  const reason = typeof claims.reason === "string" ? claims.reason : null;

  if (!sub || !jti || iat === null || exp === null || !issueId || !oldStatus || !newStatus || reason === null) {
    return { ok: false, error: "admin_override_jwt_claims_missing" };
  }
  if (iss !== ADMIN_OVERRIDE_ISSUER) return { ok: false, error: "admin_override_jwt_issuer_invalid" };
  if (aud !== ADMIN_OVERRIDE_AUDIENCE) return { ok: false, error: "admin_override_jwt_audience_invalid" };

  const now = Math.floor(Date.now() / 1000);
  if (exp <= now) return { ok: false, error: "admin_override_jwt_expired" };
  if (exp - iat > ADMIN_OVERRIDE_TTL_MAX_SECONDS) {
    return { ok: false, error: "admin_override_ttl_exceeded" };
  }
  if (reason.trim().length < ADMIN_OVERRIDE_REASON_MIN_LENGTH) {
    return { ok: false, error: "admin_override_reason_invalid" };
  }

  return {
    ok: true,
    claims: {
      iss,
      aud,
      sub,
      jti,
      iat,
      exp,
      issue_id: issueId,
      old_status: oldStatus,
      new_status: newStatus,
      reason,
    },
  };
}

export const ADMIN_OVERRIDE_CONSTANTS = {
  algorithm: ADMIN_OVERRIDE_ALG,
  issuer: ADMIN_OVERRIDE_ISSUER,
  audience: ADMIN_OVERRIDE_AUDIENCE,
  ttlMaxSeconds: ADMIN_OVERRIDE_TTL_MAX_SECONDS,
  reasonMinLength: ADMIN_OVERRIDE_REASON_MIN_LENGTH,
};
