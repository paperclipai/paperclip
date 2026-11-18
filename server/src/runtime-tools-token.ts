import { createHmac, timingSafeEqual } from "node:crypto";
import { resolvePaperclipInstanceId } from "./home-paths.js";

export interface RuntimeToolsTokenClaims {
  sub: string;
  company_id: string;
  run_id: string;
  responsible_user_id: string;
  scope: "connection_intents" | "github_credentials";
  iat: number;
  exp: number;
  instance_id: string;
}

const TOKEN_TTL_SECONDS = 60 * 60;
const GITHUB_CREDENTIALS_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Ceiling for credentials that leave the host (sandbox pods, remote targets). */
export const REMOTE_GITHUB_CREDENTIALS_TTL_SECONDS = 7 * 24 * 60 * 60;

function secret() {
  return process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim()
    || process.env.BETTER_AUTH_SECRET?.trim()
    || null;
}

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function sign(value: string, companyId: string, instanceId: string) {
  const master = secret();
  if (!master) return null;
  const key = createHmac("sha256", master)
    .update(`runtime-tools:${instanceId}:${companyId}`)
    .digest();
  return createHmac("sha256", key).update(value).digest("base64url");
}

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createRuntimeToolsToken(input: {
  agentId: string;
  companyId: string;
  runId: string;
  responsibleUserId: string;
  scope?: RuntimeToolsTokenClaims["scope"];
  /** Upper bound on the scope's default lifetime; it can only shorten it. */
  maxTtlSeconds?: number;
}) {
  if (!secret()) return null;
  // A cap can only shorten the lifetime; an invalid cap must never silently disable it.
  if (input.maxTtlSeconds !== undefined && !(Number.isFinite(input.maxTtlSeconds) && input.maxTtlSeconds >= 1)) {
    throw new Error("maxTtlSeconds must be a finite number of at least 1");
  }
  const maxTtl = input.maxTtlSeconds === undefined ? undefined : Math.floor(input.maxTtlSeconds);
  const now = Math.floor(Date.now() / 1000);
  const instanceId = resolvePaperclipInstanceId();
  const claims: RuntimeToolsTokenClaims = {
    sub: input.agentId,
    company_id: input.companyId,
    run_id: input.runId,
    responsible_user_id: input.responsibleUserId,
    scope: input.scope ?? "connection_intents",
    iat: now,
    // Broker tokens remain scoped to a live run, which is rechecked on every use.
    exp: now + Math.min(
      input.scope === "github_credentials" ? GITHUB_CREDENTIALS_TTL_SECONDS : TOKEN_TTL_SECONDS,
      maxTtl ?? Number.POSITIVE_INFINITY,
    ),
    instance_id: instanceId,
  };
  const signingInput = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(claims)}`;
  const signature = sign(signingInput, input.companyId, instanceId);
  return signature
    ? { token: `${signingInput}.${signature}`, expiresAt: new Date(claims.exp * 1000).toISOString() }
    : null;
}

export function verifyRuntimeToolsToken(token: string, scope: RuntimeToolsTokenClaims["scope"] = "connection_intents"): RuntimeToolsTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (header.alg !== "HS256") return null;
  const companyId = typeof claims.company_id === "string" ? claims.company_id : null;
  const instanceId = typeof claims.instance_id === "string" ? claims.instance_id : null;
  if (!companyId || !instanceId || instanceId !== resolvePaperclipInstanceId()) return null;
  const expected = sign(`${parts[0]}.${parts[1]}`, companyId, instanceId);
  if (!expected || !safeEqual(parts[2]!, expected)) return null;
  if (
    typeof claims.sub !== "string"
    || typeof claims.run_id !== "string"
    || typeof claims.responsible_user_id !== "string"
    || claims.scope !== scope
    || typeof claims.iat !== "number"
    || typeof claims.exp !== "number"
    || claims.exp <= Math.floor(Date.now() / 1000)
  ) return null;
  return claims as unknown as RuntimeToolsTokenClaims;
}
