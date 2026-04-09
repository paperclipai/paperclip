import { createHmac, timingSafeEqual } from "node:crypto";

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
}

const JWT_ALGORITHM = "HS256";

/**
 * Derive a per-company signing key from the master JWT secret and a companyId.
 * This ensures that a JWT forged with one company's key cannot be used to
 * authenticate as an agent in a different company, even if the attacker has
 * access to the raw JWT of another company's agent.
 *
 * Returns `null` when no master secret is configured (local_trusted mode).
 */
export function deriveCompanySigningKey(companyId: string): string | null {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`jwt:${companyId}`).digest("hex");
}

/**
 * Resolver function suitable for passing to `verifyLocalAgentJwt`. Looks up
 * the per-company key for the given companyId.
 */
export async function resolveCompanySigningKey(companyId: string): Promise<string | null> {
  return deriveCompanySigningKey(companyId);
}

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function jwtConfig() {
  const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) return null;

  return {
    secret,
    ttlSeconds: parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 3_600),
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

export function createLocalAgentJwt(
  agentId: string,
  companyId: string,
  adapterType: string,
  runId: string,
  companySigningKey?: string,
) {
  const config = jwtConfig();
  if (!config) return null;

  const signingSecret = companySigningKey ?? config.secret;

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
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(signingSecret, signingInput);

  return `${signingInput}.${signature}`;
}

export async function verifyLocalAgentJwt(
  token: string,
  resolveCompanyKey?: (companyId: string) => Promise<string | null>,
): Promise<LocalAgentJwtClaims | null> {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  // Parse header and claims WITHOUT verifying the signature first so we can
  // extract company_id and resolve a per-company signing key.
  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  if (!companyId) return null;

  // Determine the signing secret: prefer per-company key, fall back to instance-wide.
  let signingSecret = config.secret;
  if (resolveCompanyKey) {
    const companyKey = await resolveCompanyKey(companyId);
    if (companyKey) {
      signingSecret = companyKey;
    }
  }

  // Now verify the signature with the resolved secret.
  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(signingSecret, signingInput);
  if (!safeCompare(signature, expectedSig)) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !adapterType || !runId || !iat || !exp) return null;

  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;

  const issuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const audience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (issuer && issuer !== config.issuer) return null;
  if (audience && audience !== config.audience) return null;

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
  };
}
