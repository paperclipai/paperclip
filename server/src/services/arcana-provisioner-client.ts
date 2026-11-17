/**
 * Thin client for Arcana's brain provisioning route (TECH-7252; Arcana PRs #41/#43).
 *
 * `POST {ARCANA_URL}/api/v1/brain/provision` registers an agent's private brain, idempotently:
 * 201 on first provision, 200 on an identical replay, 409 when the identity, key or status conflicts.
 * Paperclip generates the exchange key and sends ONLY its sha256 hex; Arcana never sees the key. The
 * bearer is a 60-second service JWT minted per request from the provisioning signing key (rh-auth caps authority
 * tokens at 15 minutes, so a static token could never work). It carries only scope `arc:brain:provision`: it
 * cannot read content or mint tokens. Error bodies are never read or logged.
 *
 * Identity derivation (deterministic, so a retry or a re-created hook always names the same brain):
 * principal and runtime ids are lowercase UUIDs taken from sha256 over a domain-separated string
 * `paperclip:arcana-brain:<principal|runtime>:<companyId>:<agentId>` (first 16 bytes, version nibble 5,
 * RFC 4122 variant). The two domains never collide, as Arcana requires.
 */
import { isUnreachableTailnetPort, tailnetAwareFetch } from "./remote-http-fetch.js";
import { createHash, createHmac } from "node:crypto";
import {
  ARCANA_MCP_URL_ENV,
  ARCANA_PROVISION_KEY_ENV,
  ARCANA_URL_ENV,
  arcanaSnapshotFromEnv,
  readArcanaProvisionerSnapshot,
} from "../secrets/arcana-provisioner-credentials.js";
import type { DefaultMcpSetupReason } from "./default-mcp-spec.js";

export { ARCANA_MCP_URL_ENV, ARCANA_PROVISION_KEY_ENV, ARCANA_URL_ENV };

export const ARCANA_REQUEST_TIMEOUT_MS = 10_000;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ArcanaProvisionerConfig {
  arcanaUrl: string;
  /** The HS256 signing key (kid `paperclip-brain-provision`); a fresh 60s token is minted from it per request. */
  provisionKey: string;
}

function validEndpoint(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return !isUnreachableTailnetPort(url);
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

export type ArcanaProvisionerConfigResult =
  | { ok: true; config: ArcanaProvisionerConfig }
  | { ok: false; reason: "provisioner_not_configured" | "provisioner_config_invalid" };

/** Live source (no argument, or `process.env`) is the FROZEN boot snapshot; an injected env is converted purely. */
export function resolveArcanaProvisionerConfig(env?: NodeJS.ProcessEnv): ArcanaProvisionerConfigResult {
  const snapshot = env === undefined || env === process.env ? readArcanaProvisionerSnapshot() : arcanaSnapshotFromEnv(env);
  if (!snapshot.arcanaUrl || !snapshot.provisionKey) return { ok: false, reason: "provisioner_not_configured" };
  if (!validEndpoint(snapshot.arcanaUrl)) return { ok: false, reason: "provisioner_config_invalid" };
  return {
    ok: true,
    config: { arcanaUrl: snapshot.arcanaUrl.replace(/\/+$/, ""), provisionKey: snapshot.provisionKey },
  };
}

export type ArcanaMcpUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: "mcp_url_not_configured" | "mcp_url_invalid" };

/** The frozen MCP endpoint for the static template. https, or http on loopback only; never logged. */
export function resolveArcanaMcpUrl(env?: NodeJS.ProcessEnv): ArcanaMcpUrlResult {
  const snapshot = env === undefined || env === process.env ? readArcanaProvisionerSnapshot() : arcanaSnapshotFromEnv(env);
  if (!snapshot.mcpUrl) return { ok: false, reason: "mcp_url_not_configured" };
  if (!validEndpoint(snapshot.mcpUrl)) return { ok: false, reason: "mcp_url_invalid" };
  return { ok: true, url: snapshot.mcpUrl };
}

/** The MCP endpoint of a static-catalog template: Arcana's frozen URL, or `<env var><path>` for an entry that names its own source. */
export function resolveStaticTemplateMcpUrl(
  source: { env: string; path?: string } | undefined,
  env?: NodeJS.ProcessEnv,
): ArcanaMcpUrlResult {
  if (!source) return resolveArcanaMcpUrl(env);
  const base = ((env ?? process.env)[source.env] ?? "").trim().replace(/\/+$/, "");
  if (!base) return { ok: false, reason: "mcp_url_not_configured" };
  const url = `${base}${source.path ?? ""}`;
  if (!validEndpoint(url)) return { ok: false, reason: "mcp_url_invalid" };
  return { ok: true, url };
}

function uuidFromDomain(domain: "principal" | "runtime", companyId: string, agentId: string): string {
  const bytes = createHash("sha256").update(`paperclip:arcana-brain:${domain}:${companyId}:${agentId}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Version of the `uuidFromDomain` recipe below. Bump it only with a new recipe; stored ids keep the version they were made with. */
export const ARCANA_IDENTITY_RECIPE_VERSION = 1;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The brain identity of an agent. Null unless both ids are canonical UUIDs. */
export function composeArcanaBrainIdentity(companyId: string, agentId: string) {
  if (!UUID_PATTERN.test(companyId) || !UUID_PATTERN.test(agentId)) return null;
  const company = companyId.toLowerCase();
  const agent = agentId.toLowerCase();
  const agentPrincipalId = uuidFromDomain("principal", company, agent);
  const runtimeId = uuidFromDomain("runtime", company, agent);
  return { agentPrincipalId, runtimeId, companyId: company, brainId: `agent:${agentPrincipalId}` };
}

export const ARCANA_PROVISION_KID = "paperclip-brain-provision";
export const ARCANA_PROVISION_SUB = "paperclip-brain-provisioner";
export const ARCANA_PROVISION_AUDIENCE = "arcana-brain";
export const ARCANA_PROVISION_SCOPE = "arc:brain:provision";
export const ARCANA_PROVISION_TOKEN_TTL_SECONDS = 60;
/** iat is backdated so a client clock slightly ahead of Arcana's does not look like a future-issued token. */
export const ARCANA_PROVISION_IAT_SKEW_SECONDS = 10;

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");

/** Mints a short-lived HS256 rh-auth service JWT from the provisioning signing key. Never logs or returns the key. */
export function mintArcanaProvisionToken(signingKey: string, nowMs: number = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const iat = now - ARCANA_PROVISION_IAT_SKEW_SECONDS;
  const header = b64url(JSON.stringify({ alg: "HS256", kid: ARCANA_PROVISION_KID, typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      sub: ARCANA_PROVISION_SUB,
      iss: "rh-auth",
      aud: ARCANA_PROVISION_AUDIENCE,
      iat,
      exp: now + ARCANA_PROVISION_TOKEN_TTL_SECONDS,
      scopes: [ARCANA_PROVISION_SCOPE],
      kind: "service",
    }),
  );
  const signature = createHmac("sha256", signingKey).update(`${header}.${claims}`).digest();
  return `${header}.${claims}.${b64url(signature)}`;
}

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");

export type ArcanaProvisionOutcome =
  | { ok: true; created: boolean; brainId: string }
  | { ok: false; reason: DefaultMcpSetupReason; retryable: boolean };

async function discard(response: Response) {
  try {
    await response.body?.cancel();
  } catch {}
}

export async function provisionArcanaBrain(
  config: ArcanaProvisionerConfig,
  request: { agentPrincipalId: string; companyId: string; runtimeId: string; exchangeKeyHash: string },
  fetchImpl: FetchLike = tailnetAwareFetch,
  timeoutMs: number = ARCANA_REQUEST_TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<ArcanaProvisionOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.arcanaUrl}/api/v1/brain/provision`, {
      method: "POST",
      headers: { authorization: `Bearer ${mintArcanaProvisionToken(config.provisionKey, now())}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        agent_principal_id: request.agentPrincipalId,
        company_id: request.companyId,
        runtime_id: request.runtimeId,
        exchange_key_hash: request.exchangeKeyHash,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { ok: false, reason: "provisioner_failed", retryable: true };
  }
  if (response.status === 200 || response.status === 201) {
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {}
    const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    if (record.status === "active" && record.brain_id === `agent:${request.agentPrincipalId}`) {
      return { ok: true, created: response.status === 201, brainId: record.brain_id };
    }
    return { ok: false, reason: "provisioner_failed", retryable: true };
  }
  await discard(response);
  if (response.status === 409) return { ok: false, reason: "provision_conflict", retryable: false };
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return { ok: false, reason: "provisioner_failed", retryable: true };
  }
  return { ok: false, reason: "provision_rejected", retryable: false };
}
