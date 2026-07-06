import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolvePaperclipEnvPath } from "./paths.js";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface LocalAgentJwtClaims {
  sub: string;
  company_id: string;
  adapter_type: string;
  run_id: string;
  responsible_user_id?: string | null;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
  jti?: string;
}

const JWT_ALGORITHM = "HS256";

const LOCAL_AGENT_JWT_SECRET_FILENAME = "agent-jwt-secret";

// Cache only the auto-provisioned file secret. Explicitly configured env
// secrets are always re-read so tests / runtime overrides stay dynamic.
let cachedLocalFileSecret: string | undefined;

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function parseBooleanEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

/**
 * Resolve the HMAC secret used to sign and verify per-run agent JWTs.
 *
 * Priority:
 *   1. PAPERCLIP_AGENT_JWT_SECRET / BETTER_AUTH_SECRET (explicit config).
 *   2. local_trusted only: a persistent, machine-local secret auto-provisioned
 *      next to the Paperclip env file. In local_trusted the same server process
 *      both signs and verifies the token, so a self-generated secret is
 *      sufficient and removes the need to run onboarding just to get correct
 *      agent attribution in local dev. Without this, every agent run fails to
 *      mint a token, no PAPERCLIP_API_KEY is injected, and API calls fall back
 *      to the local-board admin actor (see BMAAA-17).
 *
 * Returns null when no secret is available (e.g. authenticated deployments,
 * which must use an explicitly configured secret), preserving prior behaviour
 * for non-local deployments.
 */
function resolveAgentJwtSecret(): string | null {
  const configured =
    process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim();
  if (configured) return configured;

  const deploymentMode = process.env.PAPERCLIP_DEPLOYMENT_MODE?.trim() || "local_trusted";
  if (deploymentMode !== "local_trusted") return null;

  if (cachedLocalFileSecret) return cachedLocalFileSecret;

  try {
    const secretPath = join(dirname(resolvePaperclipEnvPath()), LOCAL_AGENT_JWT_SECRET_FILENAME);
    if (existsSync(secretPath)) {
      const existing = readFileSync(secretPath, "utf8").trim();
      if (existing) {
        cachedLocalFileSecret = existing;
        return existing;
      }
    }
    // Atomically create the secret file so two processes racing on first
    // boot do not each cache a different secret. The loser gets EEXIST and
    // re-reads the winner's value rather than clobbering it.
    const generated = randomBytes(48).toString("base64url");
    mkdirSync(dirname(secretPath), { recursive: true });
    try {
      writeFileSync(secretPath, `${generated}\n`, { flag: "wx", mode: 0o600 });
      cachedLocalFileSecret = generated;
      return generated;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        const winner = readFileSync(secretPath, "utf8").trim();
        if (winner) {
          cachedLocalFileSecret = winner;
          return winner;
        }
      }
      throw err;
    }
  } catch {
    return null;
  }
}

/**
 * Diagnostic summary of the agent JWT secret source, for the startup banner.
 */
export function describeAgentJwtSecret(): { status: "pass" | "warn"; message: string } {
  if (process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim()) {
    return { status: "pass", message: "set" };
  }
  const deploymentMode = process.env.PAPERCLIP_DEPLOYMENT_MODE?.trim() || "local_trusted";
  if (deploymentMode === "local_trusted" && resolveAgentJwtSecret()) {
    return { status: "pass", message: "auto-provisioned (local_trusted)" };
  }
  return { status: "warn", message: "missing (run `pnpm paperclipai onboard`)" };
}

function jwtConfig() {
  const secret = resolveAgentJwtSecret();
  if (!secret) return null;

  return {
    secret,
    ttlSeconds: parseNumber(process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS, 60 * 60),
    issuer: process.env.PAPERCLIP_AGENT_JWT_ISSUER ?? "paperclip",
    audience: process.env.PAPERCLIP_AGENT_JWT_AUDIENCE ?? "paperclip-api",
    disableLegacyFallback: parseBooleanEnv(process.env.PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK),
  };
}

/**
 * Derive a per-company signing key from the master JWT secret and a companyId.
 *
 * In a multi-tenant deployment this ensures that a JWT signed for company A
 * cannot be reused to authenticate as an agent in company B, even if the raw
 * token leaks. The instance-wide master secret is never used to sign new
 * tokens — it is retained only as a verification fallback so that tokens
 * issued before this change continue to validate.
 *
 * The derivation domain-separates with the `jwt:` prefix so the same master
 * secret can safely be reused for other HMAC purposes without key reuse.
 */
function deriveCompanySigningKey(masterSecret: string, companyId: string): string {
  return createHmac("sha256", masterSecret).update(`jwt:${companyId}`).digest("hex");
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
  responsibleUserId?: string | null,
) {
  const config = jwtConfig();
  if (!config) return null;

  const now = Math.floor(Date.now() / 1000);
  const claims: LocalAgentJwtClaims = {
    sub: agentId,
    company_id: companyId,
    adapter_type: adapterType,
    run_id: runId,
    responsible_user_id: responsibleUserId?.trim() || null,
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
  // Sign with the per-company derived key so a leaked token cannot be reused
  // across tenants.
  const signingKey = deriveCompanySigningKey(config.secret, companyId);
  const signature = signPayload(signingKey, signingInput);

  return `${signingInput}.${signature}`;
}

export function verifyLocalAgentJwt(token: string): LocalAgentJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
  if (!config) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, claimsB64, signature] = parts;

  const header = parseJson(base64UrlDecode(headerB64));
  if (!header || header.alg !== JWT_ALGORITHM) return null;

  const claims = parseJson(base64UrlDecode(claimsB64));
  if (!claims) return null;

  const claimedCompanyId = typeof claims.company_id === "string" ? claims.company_id : null;
  if (!claimedCompanyId) return null;

  const signingInput = `${headerB64}.${claimsB64}`;
  // Try the per-company derived key first (current tokens). Fall back to the
  // raw master secret so tokens issued before per-company derivation existed
  // continue to verify — this preserves backward compatibility for any
  // outstanding tokens (TTL bounds the legacy window naturally).
  //
  // Operators should set `PAPERCLIP_AGENT_JWT_DISABLE_LEGACY_FALLBACK=true`
  // approximately one JWT TTL (~1h by default, see PAPERCLIP_AGENT_JWT_TTL_SECONDS)
  // after deploying per-company signing. Once set, the master-secret fallback
  // is disabled and only tokens validating under the per-company derived key
  // are accepted — closing the window in which a leaked master secret could
  // be used to forge tokens with arbitrary future `exp` values for any tenant.
  const perCompanyKey = deriveCompanySigningKey(config.secret, claimedCompanyId);
  const perCompanySig = signPayload(perCompanyKey, signingInput);
  let signatureOk = safeCompare(signature, perCompanySig);
  if (!signatureOk && !config.disableLegacyFallback) {
    const legacySig = signPayload(config.secret, signingInput);
    signatureOk = safeCompare(signature, legacySig);
  }
  if (!signatureOk) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const adapterType = typeof claims.adapter_type === "string" ? claims.adapter_type : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const responsibleUserClaim = Object.hasOwn(claims, "responsible_user_id")
    ? typeof claims.responsible_user_id === "string" && claims.responsible_user_id.trim()
      ? claims.responsible_user_id.trim()
      : null
    : undefined;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!sub || !adapterType || !runId || !iat || !exp) return null;
  const companyId = claimedCompanyId;

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
    ...(responsibleUserClaim !== undefined ? { responsible_user_id: responsibleUserClaim } : {}),
    iat,
    exp,
    ...(issuer ? { iss: issuer } : {}),
    ...(audience ? { aud: audience } : {}),
    jti: typeof claims.jti === "string" ? claims.jti : undefined,
  };
}
