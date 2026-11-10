import { createHmac, timingSafeEqual } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { resolvePaperclipInstanceId } from "./home-paths.js";

export interface RuntimeToolsTokenClaims {
  sub: string;
  company_id: string;
  run_id: string;
  responsible_user_id: string;
  scope: "connection_intents" | "github_credentials" | "git_credentials";
  iat: number;
  exp: number;
  instance_id: string;
  github_project_repositories?: string[];
  github_project_bindings?: Array<{ projectId: string; repositoryUrl: string }>;
  azure_project_repositories?: Array<{ projectId: string; repositoryUrl: string }>;
  allow_github?: boolean;
}

const TOKEN_TTL_SECONDS = 60 * 60;
const MAX_REPOSITORY_BINDINGS = 1000;
const MAX_TOKEN_LENGTH = 12_000;
const MAX_CLAIMS_BYTES = 1_000_000;

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
  githubProjectRepositories?: string[];
  githubProjectBindings?: Array<{ projectId: string; repositoryUrl: string }>;
  azureProjectRepositories?: Array<{ projectId: string; repositoryUrl: string }>;
  allowGitHub?: boolean;
}) {
  if (!secret()) return null;
  if ([input.githubProjectRepositories, input.githubProjectBindings, input.azureProjectRepositories]
    .some(items => items && items.length > MAX_REPOSITORY_BINDINGS)) throw new Error("Too many repository bindings for a managed Git runtime");
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
    exp: now + (input.scope === "github_credentials" || input.scope === "git_credentials" ? 30 * 24 * 60 * 60 : TOKEN_TTL_SECONDS),
    instance_id: instanceId,
    ...(input.githubProjectRepositories ? { github_project_repositories: input.githubProjectRepositories } : {}),
    ...(input.githubProjectBindings ? { github_project_bindings: input.githubProjectBindings } : {}),
    ...(input.azureProjectRepositories ? { azure_project_repositories: input.azureProjectRepositories } : {}),
    ...(input.allowGitHub ? { allow_github: true } : {}),
  };
  const raw = Buffer.from(JSON.stringify(claims), "utf8");
  if (raw.length > MAX_CLAIMS_BYTES) throw new Error("Managed Git runtime repository bindings are too large");
  const compressed = raw.length > 6000;
  const payload = compressed ? deflateRawSync(raw).toString("base64url") : raw.toString("base64url");
  const signingInput = `${encode({ alg: "HS256", typ: "JWT", ...(compressed ? { zip: "DEF" } : {}) })}.${payload}`;
  if (signingInput.length + 44 > MAX_TOKEN_LENGTH) throw new Error("Managed Git runtime repository bindings are too large");
  const signature = sign(signingInput, input.companyId, instanceId);
  return signature
    ? { token: `${signingInput}.${signature}`, expiresAt: new Date(claims.exp * 1000).toISOString() }
    : null;
}

export function verifyRuntimeToolsToken(token: string, scope: RuntimeToolsTokenClaims["scope"] = "connection_intents"): RuntimeToolsTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || token.length > MAX_TOKEN_LENGTH) return null;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    if (header.zip !== undefined && header.zip !== "DEF") return null;
    const payload = Buffer.from(parts[1]!, "base64url");
    claims = JSON.parse((header.zip === "DEF" ? inflateRawSync(payload, { maxOutputLength: MAX_CLAIMS_BYTES }) : payload).toString("utf8"));
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
    || (claims.allow_github !== undefined && typeof claims.allow_github !== "boolean")
    || (claims.github_project_repositories !== undefined && (!Array.isArray(claims.github_project_repositories) || claims.github_project_repositories.length > MAX_REPOSITORY_BINDINGS || claims.github_project_repositories.some((item) => typeof item !== "string" || item.length > 2048)))
    || (claims.github_project_bindings !== undefined && (!Array.isArray(claims.github_project_bindings) || claims.github_project_bindings.length > MAX_REPOSITORY_BINDINGS || claims.github_project_bindings.some((item) => !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => key !== "projectId" && key !== "repositoryUrl") || typeof item.projectId !== "string" || item.projectId.length > 2048 || typeof item.repositoryUrl !== "string" || item.repositoryUrl.length > 2048)))
    || (claims.azure_project_repositories !== undefined && (!Array.isArray(claims.azure_project_repositories) || claims.azure_project_repositories.length > MAX_REPOSITORY_BINDINGS || claims.azure_project_repositories.some((item) => !item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => key !== "projectId" && key !== "repositoryUrl") || typeof item.projectId !== "string" || item.projectId.length > 2048 || typeof item.repositoryUrl !== "string" || item.repositoryUrl.length > 2048)))
    || typeof claims.iat !== "number"
    || typeof claims.exp !== "number"
    || claims.exp <= Math.floor(Date.now() / 1000)
  ) return null;
  return claims as unknown as RuntimeToolsTokenClaims;
}
