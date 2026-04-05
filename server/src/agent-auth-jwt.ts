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

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

// ---------------------------------------------------------------------------
// Secret management — supports env var, GCP Secret Manager, and rotation
// ---------------------------------------------------------------------------

/** Whether initJwtSecret() has been called (enables caching). */
let initialized = false;

/** Cached primary secret (loaded once at startup via initJwtSecret). */
let cachedSecret: string | null = null;

/** Cached previous secret for dual-validation during rotation window. */
let cachedPreviousSecret: string | null = null;

/**
 * Initialise the JWT signing secret. Call once at server startup.
 *
 * Priority:
 *   1. PAPERCLIP_AGENT_JWT_SECRET env var (direct value)
 *   2. GCP Secret Manager (if PAPERCLIP_GCP_PROJECT_ID and
 *      PAPERCLIP_AGENT_JWT_SECRET_SM_NAME are set)
 *   3. null — JWT auth is disabled
 *
 * During rotation the previous secret is sourced from:
 *   - PAPERCLIP_AGENT_JWT_SECRET_PREVIOUS env var
 */
export async function initJwtSecret(): Promise<void> {
  initialized = true;
  cachedSecret = null;

  // Primary secret — env var takes precedence
  const envSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  if (envSecret) {
    cachedSecret = envSecret;
  } else {
    // Attempt GCP Secret Manager
    const gcpProject = process.env.PAPERCLIP_GCP_PROJECT_ID;
    const smName = process.env.PAPERCLIP_AGENT_JWT_SECRET_SM_NAME;
    const smVersion = process.env.PAPERCLIP_AGENT_JWT_SECRET_SM_VERSION ?? "latest";

    if (gcpProject && smName) {
      try {
        const mod = await import("@google-cloud/secret-manager");
        const client = new mod.SecretManagerServiceClient();
        const resourceName = `projects/${gcpProject}/secrets/${smName}/versions/${smVersion}`;
        const [response] = await client.accessSecretVersion({ name: resourceName });
        const payload = response.payload?.data;
        if (payload) {
          cachedSecret = typeof payload === "string"
            ? payload
            : Buffer.from(payload).toString("utf8");
        }
      } catch (err) {
        // Log but don't crash — fall through to null (JWT auth disabled)
        console.error("[agent-auth-jwt] Failed to load JWT secret from GCP Secret Manager:", err);
      }
    }
  }

  // Previous secret for rotation window
  cachedPreviousSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET_PREVIOUS || null;
}

function getSecret(): string | null {
  // When initJwtSecret() has been called, use the cached value.
  // Otherwise (tests, or startup not reached yet), read live from env.
  if (initialized) return cachedSecret;
  return process.env.PAPERCLIP_AGENT_JWT_SECRET || null;
}

function getPreviousSecret(): string | null {
  if (initialized) return cachedPreviousSecret;
  return process.env.PAPERCLIP_AGENT_JWT_SECRET_PREVIOUS || null;
}

function jwtConfig() {
  const secret = getSecret();
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
    alg: JWT_ALGORITHM,
    typ: "JWT",
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);

  return `${signingInput}.${signature}`;
}

/**
 * Verify a JWT token against the current secret and, during rotation, the
 * previous secret. This dual-validation allows a seamless rotation window
 * where tokens signed with the old secret remain valid until they expire.
 */
export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  // Try current secret first
  const result = verifyWithSecret(token, config.secret, config.issuer, config.audience);
  if (result) return result;

  // During rotation, try previous secret
  const previousSecret = getPreviousSecret();
  if (previousSecret) {
    return verifyWithSecret(token, previousSecret, config.issuer, config.audience);
  }

  return null;
}

function verifyWithSecret(
  token: string,
  secret: string,
  issuer: string,
  audience: string,
): LocalAgentJwtClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  const expectedSig = signPayload(secret, signingInput);
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

  const claimIssuer = typeof claims.iss === "string" ? claims.iss : undefined;
  const claimAudience = typeof claims.aud === "string" ? claims.aud : undefined;
  if (claimIssuer && claimIssuer !== issuer) return null;
  if (claimAudience && claimAudience !== audience) return null;

  return {
    sub,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    iat,
    exp,
    ...(claimIssuer ? { iss: claimIssuer } : {}),
    ...(claimAudience ? { aud: claimAudience } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
