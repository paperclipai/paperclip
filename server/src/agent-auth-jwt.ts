import { createHmac, createSign, createVerify, createPublicKey, timingSafeEqual } from "node:crypto";
import { verifyDpopProof, extractDpopHeader, computeAccessTokenHash, type JwkPublicKey } from "./dpop.js";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface LocalAgentJwtClaims {
  sub: string;
  company_id: string;
  adapter_type: string;
  run_id: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  jti?: string;
  // AllCare: DPoP confirmation claim
  cnf?: { jkt: string };
  scopes?: string[];
}

const JWT_ALGORITHM_HMAC = "HS256";
const JWT_ALGORITHM_EC = "ES256";

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function jwtConfig() {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) return null;

  return {
    secret,
    ttlSeconds: parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 60 * 60 * 48),
    issuer: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip",
    audience: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api",
  };
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
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
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
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

/**
 * Create an HS256 JWT (original Paperclip behavior, backward compatible).
 */
export function createLocalAgentJwt(agentId: string, companyId: string, adapterType: string, runId: string) {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };

  const header = {
    alg: JWT_ALGORITHM_HMAC,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);

  return `${signingInput}.${signature}`;
}

/**
 * Create a DPoP-bound ES256 JWT with cnf.jkt claim.
 * The token is bound to the agent's public key thumbprint.
 */
export function createDpopBoundAgentJwt(
  agentId: string,
  companyId: string,
  adapterType: string,
  runId: string,
  jkt: string,
  scopes: string[],
) {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const ttl = parseNumber(process.env.PAPERCLIP_DPOP_JWT_TTL_SECONDS, 60 * 60); // 1hr default for DPoP
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat: now,
    exp: now + ttl,
    iss: config.issuer,
    aud: config.audience,
    cnf: { jkt },
    scopes,
  };

  const header = {
    alg: JWT_ALGORITHM_HMAC, // Server-side token still uses HMAC (server secret signs it)
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);

  return `${signingInput}.${signature}`;
}

/**
 * Verify an agent JWT. Supports both plain HS256 and DPoP-bound tokens.
 * For DPoP-bound tokens (those with cnf.jkt), also verifies the DPoP proof header.
 */
export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM_HMAC) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(config.secret, signingInput);
  if (!safeCompare(signature, expectedSig)) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !companyId || !adapterType || !runId || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) return null;
  if (audience && audience !== config.audience) return null;

  // Parse DPoP confirmation claim if present
  const cnf = claims.cnf && typeof claims.cnf === "object" && !Array.isArray(claims.cnf)
    ? { jkt: (claims.cnf as Record<string, unknown>).jkt as string }
    : undefined;

  // Parse scopes if present
  const scopes = Array.isArray(claims.scopes) ? claims.scopes as string[] : undefined;

  return {
    sub,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
    ...(cnf ? { cnf } : {}),
    ...(scopes ? { scopes } : {}),
  };
}

/**
 * Full DPoP-aware verification: verify both the access token and the DPoP proof.
 * Use this for endpoints that require DPoP when the agent has dpop_enabled.
 */
export function verifyDpopBoundRequest(
  accessToken: string,
  dpopHeader: string | null,
  httpMethod: string,
  httpUri: string,
): { claims: LocalAgentJwtClaims | null; error: string | null } {
  const claims = verifyLocalAgentJwt(accessToken);
  if (!claims) return { claims: null, error: "Invalid access token" };

  // If token has no cnf claim, it's a plain token (backward compatible)
  if (!claims.cnf?.jkt) return { claims, error: null };

  // Token is DPoP-bound: require DPoP proof header
  if (!dpopHeader) return { claims: null, error: "DPoP proof required for sender-constrained token" };

  const ath = computeAccessTokenHash(accessToken);
  const result = verifyDpopProof(dpopHeader, httpMethod, httpUri, claims.cnf.jkt, ath);

  if (!result.valid) return { claims: null, error: `DPoP verification failed: ${result.error}` };

  return { claims, error: null };
}
