import { createHmac, timingSafeEqual } from "node:crypto";

interface JwtHeader {
  alg: string;
  typ?: string;
}

export interface WorkflowRunJwtClaims {
  sub: string;
  company_id: string;
  workflow_id: string;
  run_id: string;
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
}

const JWT_ALGORITHM = "HS256";

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.floor(parsed);
}

function jwtConfig() {
  const secret = process.env.BIZBOX_WORKFLOW_JWT_SECRET?.trim()
    || process.env.BIZBOX_AGENT_JWT_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim();
  if (!secret) return null;
  return {
    secret,
    ttlSeconds: parseNumber(process.env.BIZBOX_WORKFLOW_JWT_TTL_SECONDS, 60 * 60 * 8),
    issuer: process.env.BIZBOX_WORKFLOW_JWT_ISSUER ?? "paperclip-workflows",
    audience: process.env.BIZBOX_WORKFLOW_JWT_AUDIENCE ?? "paperclip-workflow-runtime",
  };
}

function base64UrlEncode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
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

export function createWorkflowRunJwt(workflowId: string, companyId: string, runId: string) {
  const config = jwtConfig();
  if (!config) return null;
  const now = Math.floor(Date.now() / 1000);
  const claims: WorkflowRunJwtClaims = {
    sub: workflowId,
    company_id: companyId,
    workflow_id: workflowId,
    run_id: runId,
    iat: now,
    exp: now + config.ttlSeconds,
    iss: config.issuer,
    aud: config.audience,
  };
  const header: JwtHeader = { alg: JWT_ALGORITHM, typ: "JWT" };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;
  const signature = signPayload(config.secret, signingInput);
  return `${signingInput}.${signature}`;
}

export function verifyWorkflowRunJwt(token: string): WorkflowRunJwtClaims | null {
  if (!token) return null;
  const config = jwtConfig();
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
  const workflowId = typeof claims.workflow_id === "string" ? claims.workflow_id : null;
  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const runId = typeof claims.run_id === "string" ? claims.run_id : null;
  const sub = typeof claims.sub === "string" ? claims.sub : null;
  const iat = typeof claims.iat === "number" ? claims.iat : null;
  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (!workflowId || !companyId || !runId || !sub || !iat || !exp) return null;
  const now = Math.floor(Date.now() / 1000);
  if (exp < now) return null;
  return {
    sub,
    company_id: companyId,
    workflow_id: workflowId,
    run_id: runId,
    iat,
    exp,
    iss: typeof claims.iss === "string" ? claims.iss : undefined,
    aud: typeof claims.aud === "string" ? claims.aud : undefined,
  };
}
