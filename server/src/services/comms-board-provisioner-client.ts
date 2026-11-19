/**
 * Thin clients for the two EXISTING downstream calls Redesign AI's `POST /admin/bots` makes to
 * give a bot a comms-board presence (TECH-7204). Paperclip calls them directly instead of the
 * whole admin route, which would also create an unrelated Redesign AI user + `api_key` and needs
 * broad `redesign-ai:rh:admin` authority. No new token service or registry is introduced.
 *
 * 1. Board identity: agent-comms-mcp `comms_admin_register` (JSON-RPC `tools/call` over
 *    Streamable HTTP, POST to the full MCP endpoint, Bearer = a `comms:admin` credential).
 *    Returns the board `agent_id` UUID, which Redesign AI discards and Paperclip persists.
 *    Never upserts (`already_registered`).
 * 2. Board credential: agent-comms-approvals `ownership_api` `POST {base}/agents`
 *    (Bearer = `ownership:write`). Body `{sub, owner_email, scopes, expires_in_days}`.
 *    201 `{sub, owner_email, active, token, token_expires_at}`. Insert-only: 409 when `sub`
 *    exists. A lost response leaves a valid token until it expires.
 *
 * Both credentials are SERVER control-plane config, captured from the deployment process environment at
 * boot and scrubbed from it (TECH-7228); later `.env` values are never adopted. They are never granted to the agent:
 * the agent's own token carries only `comms:read` + `comms:write` + `comms:proposals:write`. Without all four values the
 * caller records a visible pending state and nothing is called. Neither call is retried.
 *
 * Identity recipe: the token `sub` is the base (`paperclip-agent-<agentId>`, never contains
 * "::"); fresh registration uses the bare base sub (`agentKey: null`), while legacy registered
 * agents preserve their existing keyed bindings.
 */
import { isUnreachableTailnetPort, tailnetAwareFetch } from "./remote-http-fetch.js";
import { randomUUID } from "node:crypto";
import {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
  readCommsBoardProvisionerSnapshot,
  snapshotFromEnv,
} from "../secrets/comms-board-provisioner-credentials.js";
import { RH_MCP_SERVICE_TOOLS_BY_SCOPE, type DefaultMcpSetupReason } from "./default-mcp-spec.js";
import {
  buildMcpToolCallRequest,
  extractMcpToolCallResult,
  findJsonRpcResponse,
  initializeMcpHttpSession,
  McpHttpInitializationError,
  readMcpHttpResponseText,
  terminateMcpHttpSession,
} from "./mcp-http.js";

export {
  COMMS_BOARD_ADMIN_TOKEN_ENV,
  COMMS_BOARD_MCP_URL_ENV,
  COMMS_BOARD_OWNERSHIP_API_TOKEN_ENV,
  COMMS_BOARD_OWNERSHIP_API_URL_ENV,
};

export const COMMS_BOARD_REQUEST_TIMEOUT_MS = 10_000;
/** Newly provisioned bot credentials default to 365 days (TECH-7268). Downstream ownership API accepts [1, 3650]. */
export const COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS = 365;
/** Never `comms:admin` or `ownership:*`. Redesign AI's `_BOARD_CREDENTIAL_SCOPES` is still read+write only: it mints a different credential and does not carry `comms:proposals:write`. */
export const COMMS_BOARD_TOKEN_SCOPES = ["comms:read", "comms:write", "comms:proposals:write"] as const;
/**
 * Version of `COMMS_BOARD_TOKEN_SCOPES`. Bump it whenever the scope set changes. It is recorded on the agent's
 * binding when a token is minted or rotated (`binding.commsScopeVersion`) because the scopes of an existing opaque
 * token cannot be read back; the rescope job (comms-credential-rescope.ts) rotates every binding below it.
 * v1 = read + write; v2 = + `comms:proposals:write`.
 */
export const COMMS_BOARD_TOKEN_SCOPES_VERSION = 2;
/**
 * Per-agent memory credential (TECH-8409): read + write on the external memory service only. Never `comms:*`,
 * `ownership:*` or any admin scope. Minted through the same ownership registry as the comms credentials.
 */
export const AGENT_MEMORY_TOKEN_SCOPES = ["memory:read", "memory:write"] as const;
/** Memory tokens are shorter-lived than comms tokens. Downstream ownership API accepts [1, 3650]. */
export const AGENT_MEMORY_TOKEN_EXPIRES_IN_DAYS = 90;
/** The company template credential (TECH-7271) is discovery-only: read, never write/admin/ownership. */
export const COMMS_BOARD_TEMPLATE_TOKEN_SCOPES = ["comms:read"] as const;
/**
 * Scopes of the per-org rh-mcp service credential of a shared org (TECH-8066). A separate token from the comms-board
 * ones, minted through the same ownership API. rh-mcp enforces one scope per tool, so the scopes are exactly the keys of
 * `RH_MCP_SERVICE_TOOLS_BY_SCOPE` (default-mcp-spec.ts), which also lists the tools they cover. Read scopes for tools
 * that need no person only: `supabase:read` is deliberately absent (the supabase tools expose the Ashby ATS views with
 * no identity gate), and so is every `:write` scope, `argus:secrets` and `auth:impersonate`.
 */
export const RH_MCP_SERVICE_TOKEN_SCOPES: readonly string[] = Object.freeze(Object.keys(RH_MCP_SERVICE_TOOLS_BY_SCOPE));
/** Bump whenever `RH_MCP_SERVICE_TOKEN_SCOPES` changes so existing tokens can be rotated onto the new set (v2 = + `decisions:run`, TECH-9109). */
export const RH_MCP_SERVICE_TOKEN_SCOPES_VERSION = 2;

/**
 * Closed, typed credential purpose. The scopes sent downstream are looked up from this table only; there
 * is no caller-supplied scope list, so no code path can request `comms:admin` or `ownership:*`.
 */
export type CommsBoardCredentialPurpose = "bot" | "template" | "rh_mcp_service" | "memory";
const CREDENTIAL_SCOPES_BY_PURPOSE: Readonly<Record<CommsBoardCredentialPurpose, readonly string[]>> = Object.freeze({
  bot: COMMS_BOARD_TOKEN_SCOPES,
  template: COMMS_BOARD_TEMPLATE_TOKEN_SCOPES,
  rh_mcp_service: RH_MCP_SERVICE_TOKEN_SCOPES,
  memory: AGENT_MEMORY_TOKEN_SCOPES,
});
/** Per-purpose expiry for newly minted credentials. Comms purposes stay at 365 days; memory tokens are 90 days. */
const CREDENTIAL_EXPIRES_IN_DAYS_BY_PURPOSE: Readonly<Record<CommsBoardCredentialPurpose, number>> = Object.freeze({
  bot: COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS,
  template: COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS,
  rh_mcp_service: COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS,
  memory: AGENT_MEMORY_TOKEN_EXPIRES_IN_DAYS,
});

const BASE_SUB_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CommsBoardProvisionerConfig {
  boardMcpUrl: string;
  boardAdminToken: string;
  ownershipApiUrl: string;
  ownershipApiToken: string;
}

/** Loopback names that may be reached over plain HTTP (local development only). */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * A usable endpoint is an absolute `https:` URL (any host: the board and ownership APIs may sit on a
 * private tailnet), or `http:` for a loopback hostname only. Userinfo, a query string or a fragment
 * are refused so a credential can never ride in the URL. The full path is preserved as written.
 */
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

export type CommsBoardProvisionerConfigResult =
  | { ok: true; config: CommsBoardProvisionerConfig }
  | { ok: false; reason: "provisioner_not_configured" | "provisioner_config_invalid" };

/**
 * Closed-enum outcome: missing settings and invalid URLs are both a waiting state, decided before any fetch.
 *
 * The live source (no argument, or the global `process.env`) is the FROZEN boot snapshot, never the
 * current environment: the bearer tokens are scrubbed from `process.env` at startup (TECH-7228) and a
 * later environment change cannot supply or redirect them. A genuinely injected env object (tests,
 * config seams) is converted purely and never touches the snapshot.
 */
export function resolveCommsBoardProvisionerConfig(
  env?: NodeJS.ProcessEnv,
): CommsBoardProvisionerConfigResult {
  const snapshot = env === undefined || env === process.env ? readCommsBoardProvisionerSnapshot() : snapshotFromEnv(env);
  const { boardMcpUrl, boardAdminToken, ownershipApiUrl, ownershipApiToken } = snapshot;
  if (!boardMcpUrl || !boardAdminToken || !ownershipApiUrl || !ownershipApiToken) {
    return { ok: false, reason: "provisioner_not_configured" };
  }
  if (!validEndpoint(boardMcpUrl) || !validEndpoint(ownershipApiUrl)) {
    return { ok: false, reason: "provisioner_config_invalid" };
  }
  return {
    ok: true,
    config: {
      boardMcpUrl,
      boardAdminToken,
      ownershipApiUrl: ownershipApiUrl.replace(/\/+$/, ""),
      ownershipApiToken,
    },
  };
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Token subject of a company's managed template credential (TECH-7271): `paperclip-company-template-<lowercase
 * company UUID>` (63 chars, no "::"). Null for anything that is not a canonical UUID.
 */
export function composeTemplateSub(companyId: string): string | null {
  if (!UUID_PATTERN.test(companyId)) return null;
  const sub = `paperclip-company-template-${companyId.toLowerCase()}`;
  return BASE_SUB_PATTERN.test(sub) && !sub.includes("::") ? sub : null;
}

/**
 * Token subject of a shared org's rh-mcp service credential (TECH-8066): `paperclip-rh-mcp-<lowercase company UUID>`
 * (52 chars, no "::"). Null for anything that is not a canonical UUID. One credential per org, so the sub names the org.
 */
export function composeRhMcpServiceSub(companyId: string): string | null {
  if (!UUID_PATTERN.test(companyId)) return null;
  const sub = `paperclip-rh-mcp-${companyId.toLowerCase()}`;
  return BASE_SUB_PATTERN.test(sub) && !sub.includes("::") ? sub : null;
}

/**
 * Token subject of an agent's memory credential (TECH-8409): `agent-memory-<lowercase agent UUID>` (49 chars, no
 * "::"). Null for anything that is not a canonical UUID. One credential per agent, so the sub names the agent.
 */
export function composeAgentMemorySub(agentId: string): string | null {
  if (!UUID_PATTERN.test(agentId)) return null;
  const sub = `agent-memory-${agentId.toLowerCase()}`;
  return BASE_SUB_PATTERN.test(sub) && !sub.includes("::") ? sub : null;
}

/** Highest identity generation the recipe accepts (a defensive bound, not a product limit). */
export const COMMS_BOARD_MAX_IDENTITY_GENERATION = 99;

function normalizeIdentityGeneration(generation: unknown): number | null {
  if (generation === undefined || generation === null) return 0;
  if (typeof generation !== "number" || !Number.isInteger(generation)) return null;
  if (generation < 0 || generation > COMMS_BOARD_MAX_IDENTITY_GENERATION) return null;
  return generation;
}

/**
 * Stable identity values derived once from immutable inputs, then persisted.
 *
 * `generation` 0 (or absent) is the original recipe: `paperclip-agent-<agentId>`. A board identity can be burned (the
 * board and the ownership registry never reuse a registered sub, and an operator-made registration under the bare sub
 * makes setup stop at `board_conflict`), so the operator reissue route bumps a server-owned per-entry generation N >= 1
 * and the next registration uses `paperclip-agent-<agentId>-r<N>`. That is a different base sub, so the board's
 * identity-fork guard (which groups identities by the part before the first "::") does not tie it to the old one.
 */
export function composeCommsBoardIdentity(agentId: string, generation?: number | null) {
  const normalized = normalizeIdentityGeneration(generation);
  if (normalized === null) return null;
  const bare = `paperclip-agent-${agentId.toLowerCase()}`;
  const baseSub = normalized === 0 ? bare : `${bare}-r${normalized}`;
  if (!BASE_SUB_PATTERN.test(baseSub) || baseSub.includes("::")) return null;
  return { baseSub, agentKey: null, boardSub: baseSub };
}

/**
 * Board display name. The board rejects a display name already used by an active agent (`display_name_collision`), so a
 * reissued identity (generation >= 1) carries a visible suffix and can never collide with the name of the identity it
 * replaces. Generation 0 is unchanged.
 */
export function composeCommsBoardDisplayName(agentName: string | null | undefined, agentId: string, generation?: number | null): string {
  const normalized = normalizeIdentityGeneration(generation) ?? 0;
  const suffix = normalized === 0 ? agentId.slice(0, 8) : `${agentId.slice(0, 8)}-r${normalized}`;
  return `${(agentName ?? "Agent").slice(0, 200)} (${suffix})`;
}

// ---------------------------------------------------------------------------
// Board identity registration
// ---------------------------------------------------------------------------

export type BoardRegisterOutcome =
  | { ok: true; boardAgentId: string; boardSub: string }
  | { ok: false; reason: DefaultMcpSetupReason; retryable?: boolean };

/** Upper bound on response bytes scanned for the JSON-RPC reply. */
export const MAX_RESPONSE_BYTES = 1_000_000;

export interface RegisterCommsBoardAgentOptions {
  timeoutMs?: number;
  beforeToolCall?: () => Promise<void>;
}

export async function registerCommsBoardAgent(
  config: CommsBoardProvisionerConfig,
  // isShared (TECH-7390) derives from the owning company's immutable visibility -- every
  // agent inherits its company's classification, there is no per-agent override. Defaults
  // to false (private) so an unclassified/legacy company never gets upgraded to shared by omission.
  request: { boardSub: string; displayName: string; ownerEmail: string; isShared?: boolean },
  fetchImpl: FetchLike = tailnetAwareFetch,
  opts: RegisterCommsBoardAgentOptions = {},
): Promise<BoardRegisterOutcome> {
  const timeoutMs = opts.timeoutMs ?? COMMS_BOARD_REQUEST_TIMEOUT_MS;

  const adminHeaders: Record<string, string> = {
    authorization: `Bearer ${config.boardAdminToken}`,
  };

  const send = (init: RequestInit) => {
    const signal = init.signal
      ? (typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : init.signal)
      : AbortSignal.timeout(timeoutMs);
    return fetchImpl(config.boardMcpUrl, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        ...adminHeaders,
      },
      redirect: "error",
      signal,
    });
  };

  // Step 1: Handshake (strict 1MB)
  let sessionHeaders: Record<string, string>;
  const requestId = randomUUID();
  try {
    sessionHeaders = await initializeMcpHttpSession({
      send,
      headers: adminHeaders,
      requestId,
      strict: true,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      supportedVersions: ["2025-06-18", "2025-03-26"],
    });
  } catch (error) {
    if (error instanceof McpHttpInitializationError) {
      if (error.status === 401 || error.status === 403) {
        return { ok: false, reason: "board_rejected" };
      }
    }
    return { ok: false, reason: "provisioner_failed", retryable: true };
  }

  // Step 2: Checkpoint callback before non-idempotent tool call
  if (opts.beforeToolCall) {
    try {
      await opts.beforeToolCall();
    } catch (err) {
      await terminateMcpHttpSession({ send, headers: sessionHeaders, timeoutMs: 3000 });
      throw err;
    }
  }

  // Step 3: Exactly ONE tools/call
  try {
    const callId = 1;
    const toolCallBody = buildMcpToolCallRequest(callId, "comms_admin_register", {
      sub: request.boardSub,
      owner_sub: request.ownerEmail,
      owner_email: request.ownerEmail,
      display_name: request.displayName,
      is_shared: request.isShared ?? false,
    });

    let response: Response;
    try {
      response = await fetchImpl(config.boardMcpUrl, {
        method: "POST",
        headers: {
          ...sessionHeaders,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(toolCallBody),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: "board_unknown" };
    }

    if (response.status === 401 || response.status === 403) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {}
      }
      return { ok: false, reason: "board_rejected" };
    }
    if (response.status >= 400 && response.status < 500) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {}
      }
      return { ok: false, reason: "board_failed" };
    }
    if (response.status !== 200) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {}
      }
      return { ok: false, reason: "board_unknown" };
    }

    let responseText: string | null;
    try {
      responseText = await readMcpHttpResponseText(response, MAX_RESPONSE_BYTES);
    } catch {
      return { ok: false, reason: "board_unknown" };
    }
    if (responseText === null) {
      return { ok: false, reason: "board_unknown" };
    }

    const envelope = findJsonRpcResponse(
      response.headers.get("content-type"),
      responseText,
      callId,
    );
    if (!envelope) {
      return { ok: false, reason: "board_unknown" };
    }

    if ("error" in envelope) {
      return { ok: false, reason: "board_unknown" };
    }

    const toolResult = extractMcpToolCallResult(envelope.result);
    if (!toolResult) {
      return { ok: false, reason: "board_unknown" };
    }

    // Check tool error BEFORE JSON parse
    if (toolResult.isError) {
      const errorContent = toolResult.content.slice(0, 256).trim();
      const match = errorContent.match(/^([a-z_]{1,48})(?::|\s|$)/);
      const code = match ? match[1] : "";
      if (
        code === "already_registered" ||
        code === "identity_fork_detected" ||
        code === "display_name_collision"
      ) {
        return { ok: false, reason: "board_conflict" };
      }
      if (code === "access_denied" || code === "insufficient_scope") {
        return { ok: false, reason: "board_rejected" };
      }
      if (code === "invalid_request") {
        return { ok: false, reason: "board_failed" };
      }
      return { ok: false, reason: "board_unknown" };
    }

    // Success path: prefer structuredContent object, else parse content text as JSON
    let payloadRecord: Record<string, unknown> | null = null;
    if (
      toolResult.structuredContent &&
      typeof toolResult.structuredContent === "object" &&
      !Array.isArray(toolResult.structuredContent)
    ) {
      payloadRecord = toolResult.structuredContent as Record<string, unknown>;
    } else {
      try {
        const parsed = JSON.parse(toolResult.content);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          payloadRecord = parsed as Record<string, unknown>;
        }
      } catch {
        return { ok: false, reason: "board_unknown" };
      }
    }

    if (!payloadRecord) {
      return { ok: false, reason: "board_unknown" };
    }

    const rawId =
      payloadRecord.agent_id ??
      payloadRecord.board_agent_id ??
      payloadRecord.boardAgentId ??
      payloadRecord.id;
    if (typeof rawId !== "string" || !UUID_PATTERN.test(rawId)) {
      return { ok: false, reason: "board_unknown" };
    }

    const returnedSub = typeof payloadRecord.sub === "string" ? payloadRecord.sub : "";
    if (returnedSub !== request.boardSub) {
      return { ok: false, reason: "board_unknown" };
    }

    return { ok: true, boardAgentId: rawId.toLowerCase(), boardSub: request.boardSub };
  } finally {
    await terminateMcpHttpSession({ send, headers: sessionHeaders, timeoutMs: 3000 });
  }
}

// ---------------------------------------------------------------------------
// Board `is_shared` correction
// ---------------------------------------------------------------------------

/**
 * `unknown_agent`: the board has no such agent id. `rejected`: the admin credential was refused (401/403, or the tool's
 * `access_denied` / `insufficient_scope`). `failed`: anything else, including an outcome that cannot be known
 * (network error, malformed reply). Setting a boolean is idempotent, so every non-ok result is safe to re-run.
 */
export type BoardSetSharedOutcome =
  | { ok: true }
  | { ok: false; reason: "unknown_agent" | "rejected" | "failed" };

/**
 * Admin correction of an existing board agent's `is_shared` (`comms_set_agent_shared`). Registration freezes the value, and
 * this is the one supported way to change it afterwards. Same admin credential, MCP handshake and single `tools/call` as
 * `registerCommsBoardAgent`; nothing is retried.
 */
export async function setCommsBoardAgentShared(
  config: CommsBoardProvisionerConfig,
  request: { boardAgentId: string; isShared: boolean },
  fetchImpl: FetchLike = tailnetAwareFetch,
  opts: { timeoutMs?: number } = {},
): Promise<BoardSetSharedOutcome> {
  if (!UUID_PATTERN.test(request.boardAgentId)) return { ok: false, reason: "failed" };
  const timeoutMs = opts.timeoutMs ?? COMMS_BOARD_REQUEST_TIMEOUT_MS;
  const adminHeaders: Record<string, string> = { authorization: `Bearer ${config.boardAdminToken}` };
  const send = (init: RequestInit) => {
    const signal = init.signal
      ? (typeof AbortSignal.any === "function" ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : init.signal)
      : AbortSignal.timeout(timeoutMs);
    return fetchImpl(config.boardMcpUrl, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), ...adminHeaders },
      redirect: "error",
      signal,
    });
  };

  let sessionHeaders: Record<string, string>;
  try {
    sessionHeaders = await initializeMcpHttpSession({
      send,
      headers: adminHeaders,
      requestId: randomUUID(),
      strict: true,
      maxResponseBytes: MAX_RESPONSE_BYTES,
      supportedVersions: ["2025-06-18", "2025-03-26"],
    });
  } catch (error) {
    if (error instanceof McpHttpInitializationError && (error.status === 401 || error.status === 403)) {
      return { ok: false, reason: "rejected" };
    }
    return { ok: false, reason: "failed" };
  }

  try {
    const callId = 1;
    let response: Response;
    try {
      response = await fetchImpl(config.boardMcpUrl, {
        method: "POST",
        headers: { ...sessionHeaders, "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify(
          buildMcpToolCallRequest(callId, "comms_set_agent_shared", {
            agent_id: request.boardAgentId,
            is_shared: request.isShared,
          }),
        ),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return { ok: false, reason: "failed" };
    }
    if (response.status !== 200) {
      if (response.body) {
        try {
          await response.body.cancel();
        } catch {}
      }
      return { ok: false, reason: response.status === 401 || response.status === 403 ? "rejected" : "failed" };
    }
    let responseText: string | null;
    try {
      responseText = await readMcpHttpResponseText(response, MAX_RESPONSE_BYTES);
    } catch {
      return { ok: false, reason: "failed" };
    }
    if (responseText === null) return { ok: false, reason: "failed" };
    const envelope = findJsonRpcResponse(response.headers.get("content-type"), responseText, callId);
    if (!envelope || "error" in envelope) return { ok: false, reason: "failed" };
    const toolResult = extractMcpToolCallResult(envelope.result);
    if (!toolResult) return { ok: false, reason: "failed" };
    if (toolResult.isError) {
      const errorContent = toolResult.content.slice(0, 256).trim();
      const code = errorContent.match(/^([a-z_]{1,48})(?::|\s|$)/)?.[1] ?? "";
      if (code === "access_denied" || code === "insufficient_scope") return { ok: false, reason: "rejected" };
      if (code === "not_found" || code === "agent_not_found" || code === "unknown_agent") return { ok: false, reason: "unknown_agent" };
      return { ok: false, reason: "failed" };
    }
    return { ok: true };
  } finally {
    await terminateMcpHttpSession({ send, headers: sessionHeaders, timeoutMs: 3000 });
  }
}

// ---------------------------------------------------------------------------
// Board credential mint
// ---------------------------------------------------------------------------

export type MintOutcome =
  | { ok: true; boardToken: string; tokenExpiresAt: string | null }
  | { ok: false; reason: DefaultMcpSetupReason };

/**
 * Internal outcome of the purpose-typed mint. `noRowCreated` is set ONLY for a definitive refusal of the
 * (locally validated) request: HTTP 400/401/403/422. Those cannot have created a registry row, so the
 * caller may clear its pre-call checkpoint and retry with backoff. A 409, any 5xx, a network failure or a
 * malformed/contradictory 201 never carries it: the outcome is unknown or conflicting and is terminal.
 */
export type PurposeMintOutcome =
  | { ok: true; boardToken: string; tokenExpiresAt: string | null }
  | { ok: false; reason: DefaultMcpSetupReason; noRowCreated?: true };

async function mintCredentialForPurpose(
  config: CommsBoardProvisionerConfig,
  request: { baseSub: string; ownerEmail: string; purpose: CommsBoardCredentialPurpose },
  fetchImpl: FetchLike,
  timeoutMs: number,
): Promise<PurposeMintOutcome> {
  // The token base must never contain "::": the board composes `<base>::<agent_key>` itself.
  if (!BASE_SUB_PATTERN.test(request.baseSub)) return { ok: false, reason: "invalid_subject" };
  const scopes = CREDENTIAL_SCOPES_BY_PURPOSE[request.purpose];
  if (!scopes) return { ok: false, reason: "invalid_subject" };
  let response: Response;
  try {
    response = await fetchImpl(`${config.ownershipApiUrl}/agents`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.ownershipApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sub: request.baseSub,
        owner_email: request.ownerEmail,
        scopes: [...scopes],
        expires_in_days: CREDENTIAL_EXPIRES_IN_DAYS_BY_PURPOSE[request.purpose],
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    // The request may have landed and the token would be valid until it expires: never retry.
    return { ok: false, reason: "mint_unknown" };
  }
  if (response.status === 409) return { ok: false, reason: "ownership_conflict" };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "ownership_rejected", noRowCreated: true };
  if (response.status === 400 || response.status === 422) return { ok: false, reason: "ownership_failed", noRowCreated: true };
  if (response.status !== 201) return { ok: false, reason: "mint_unknown" };

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "mint_unknown" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "mint_unknown" };
  const { token, token_expires_at: expiresAt, sub, active, owner_email: ownerEmail } = body as Record<string, unknown>;
  // The issuer's response contract, all required: the registry row is for exactly the requested
  // token base, is active, and is owned by the verified owner we asked for. Anything else may still
  // have created a registry row, so it is an unknown outcome (never a grant, never retried).
  if (sub !== request.baseSub) return { ok: false, reason: "mint_unknown" };
  if (active !== true) return { ok: false, reason: "mint_unknown" };
  if (typeof ownerEmail !== "string" || ownerEmail.trim().toLowerCase() !== request.ownerEmail.trim().toLowerCase()) {
    return { ok: false, reason: "mint_unknown" };
  }
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "mint_unknown" };
  return {
    ok: true,
    boardToken: token,
    tokenExpiresAt: typeof expiresAt === "string" && expiresAt.length > 0 ? expiresAt : null,
  };
}

/** Per-bot credential (`comms:read` + `comms:write` + `comms:proposals:write`). Signature and results are unchanged. */
export async function mintCommsBoardCredential(
  config: CommsBoardProvisionerConfig,
  request: { baseSub: string; ownerEmail: string },
  fetchImpl: FetchLike = tailnetAwareFetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<MintOutcome> {
  const outcome = await mintCredentialForPurpose(config, { ...request, purpose: "bot" }, fetchImpl, timeoutMs);
  if (outcome.ok) return outcome;
  return { ok: false, reason: outcome.reason };
}

/**
 * Company template credential (`comms:read` ONLY), minted through the same ownership API with the server's
 * existing ownership token. No board admin registration and no admin credential is involved. `request.baseSub`
 * must be exactly `composeTemplateSub(companyId)`; anything else is refused locally before any call.
 */
export async function mintCommsBoardTemplateCredential(
  config: CommsBoardProvisionerConfig,
  request: { companyId: string; ownerEmail: string },
  fetchImpl: FetchLike = tailnetAwareFetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<PurposeMintOutcome> {
  const baseSub = composeTemplateSub(request.companyId);
  if (!baseSub) return { ok: false, reason: "invalid_subject" };
  return mintCredentialForPurpose(config, { baseSub, ownerEmail: request.ownerEmail, purpose: "template" }, fetchImpl, timeoutMs);
}

/**
 * Per-org rh-mcp service credential (`RH_MCP_SERVICE_TOKEN_SCOPES` ONLY, TECH-8066), minted through the same ownership
 * API with the server's existing ownership token. `request.companyId` must be a canonical UUID; the subject is always
 * `composeRhMcpServiceSub(companyId)`, never caller-supplied. The registry's insert-only rule applies: a second mint for
 * the same org is `ownership_conflict`, and the caller then rotates instead.
 */
export async function mintRhMcpServiceCredential(
  config: CommsBoardProvisionerConfig,
  request: { companyId: string; ownerEmail: string },
  fetchImpl: FetchLike = tailnetAwareFetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<PurposeMintOutcome> {
  const baseSub = composeRhMcpServiceSub(request.companyId);
  if (!baseSub) return { ok: false, reason: "invalid_subject" };
  return mintCredentialForPurpose(config, { baseSub, ownerEmail: request.ownerEmail, purpose: "rh_mcp_service" }, fetchImpl, timeoutMs);
}

/**
 * Per-agent memory credential (`AGENT_MEMORY_TOKEN_SCOPES` ONLY, 90-day expiry), minted through the same ownership
 * API with the server's existing ownership token. `request.agentId` must be a canonical UUID; the subject is always
 * `composeAgentMemorySub(agentId)`, never caller-supplied. Insert-only: a second mint for the same agent is
 * `ownership_conflict`.
 */
export async function mintAgentMemoryCredential(
  config: CommsBoardProvisionerConfig,
  request: { agentId: string; ownerEmail: string },
  fetchImpl: FetchLike = tailnetAwareFetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<PurposeMintOutcome> {
  const baseSub = composeAgentMemorySub(request.agentId);
  if (!baseSub) return { ok: false, reason: "invalid_subject" };
  return mintCredentialForPurpose(config, { baseSub, ownerEmail: request.ownerEmail, purpose: "memory" }, fetchImpl, timeoutMs);
}

// ---------------------------------------------------------------------------
// Board credential rotation (rescope)
// ---------------------------------------------------------------------------

export type RotateOutcome =
  | { ok: true; boardToken: string; tokenExpiresAt: string | null }
  | { ok: false; reason: "rotate_unknown_sub" | "rotate_deactivated" | "rotate_rejected" | "rotate_failed" | "invalid_subject" };

/**
 * `POST {ownershipApiUrl}/agents/{sub}/rotate` (TECH-5666): re-mints a token for an existing ACTIVE sub with the
 * CURRENT bot scope set, without touching ownership. The old token stays valid until its own `exp`. Never retried
 * here; the caller classifies the outcome and the operator re-runs. The returned token is the only secret and is
 * never logged or put in an error.
 */
export async function rotateCommsBoardCredential(
  config: CommsBoardProvisionerConfig,
  request: { baseSub: string },
  fetchImpl: FetchLike = tailnetAwareFetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<RotateOutcome> {
  return rotateCredentialWithScopes(config, request.baseSub, COMMS_BOARD_TOKEN_SCOPES, fetchImpl, timeoutMs);
}

/**
 * Re-issues an agent's memory credential (`AGENT_MEMORY_TOKEN_SCOPES`, 90 days) for its EXISTING `agent-memory-<id>`
 * sub (TECH-8409). The registry has no revocation: the old token stays valid until its own expiry, so a retry after a
 * partial failure is safe. The returned token is the only secret and is never logged.
 */
export async function rotateAgentMemoryCredential(
  config: CommsBoardProvisionerConfig,
  request: { agentId: string },
  fetchImpl: FetchLike = tailnetAwareFetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<RotateOutcome> {
  const baseSub = composeAgentMemorySub(request.agentId);
  if (!baseSub) return { ok: false, reason: "invalid_subject" };
  return rotateCredentialWithScopes(config, baseSub, AGENT_MEMORY_TOKEN_SCOPES, fetchImpl, timeoutMs, AGENT_MEMORY_TOKEN_EXPIRES_IN_DAYS);
}

/** Re-issues the per-org rh-mcp service credential with the CURRENT `RH_MCP_SERVICE_TOKEN_SCOPES` (TECH-8066). */
export async function rotateRhMcpServiceCredential(
  config: CommsBoardProvisionerConfig,
  request: { companyId: string },
  fetchImpl: FetchLike = tailnetAwareFetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<RotateOutcome> {
  const baseSub = composeRhMcpServiceSub(request.companyId);
  if (!baseSub) return { ok: false, reason: "invalid_subject" };
  return rotateCredentialWithScopes(config, baseSub, RH_MCP_SERVICE_TOKEN_SCOPES, fetchImpl, timeoutMs);
}

async function rotateCredentialWithScopes(
  config: CommsBoardProvisionerConfig,
  baseSub: string,
  scopes: readonly string[],
  fetchImpl: FetchLike,
  timeoutMs: number,
  expiresInDays: number = COMMS_BOARD_TOKEN_EXPIRES_IN_DAYS,
): Promise<RotateOutcome> {
  if (!BASE_SUB_PATTERN.test(baseSub)) return { ok: false, reason: "invalid_subject" };
  let response: Response;
  try {
    response = await fetchImpl(`${config.ownershipApiUrl}/agents/${encodeURIComponent(baseSub)}/rotate`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.ownershipApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ scopes: [...scopes], expires_in_days: expiresInDays }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    return { ok: false, reason: "rotate_failed" };
  }
  if (response.status === 404) return { ok: false, reason: "rotate_unknown_sub" };
  if (response.status === 409) return { ok: false, reason: "rotate_deactivated" };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "rotate_rejected" };
  if (response.status !== 200) return { ok: false, reason: "rotate_failed" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "rotate_failed" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "rotate_failed" };
  const { token, token_expires_at: expiresAt, sub, active } = body as Record<string, unknown>;
  if (sub !== baseSub || active !== true) return { ok: false, reason: "rotate_failed" };
  if (typeof token !== "string" || token.length === 0) return { ok: false, reason: "rotate_failed" };
  return {
    ok: true,
    boardToken: token,
    tokenExpiresAt: typeof expiresAt === "string" && expiresAt.length > 0 ? expiresAt : null,
  };
}

// ---------------------------------------------------------------------------
// Ownership registry read (owner sync)
// ---------------------------------------------------------------------------

export type ReadOwnershipOutcome =
  | { ok: true; ownerEmail: string; active: boolean }
  | { ok: false; reason: "registry_sub_unknown" | "registry_rejected" | "registry_failed" | "invalid_subject" };

/**
 * `GET {ownershipApiUrl}/ownership/{sub}` (needs `ownership:read` on the ownership token): the registry's current
 * owner of a sub. The registry is the authority for ownership (a human-approved reassignment writes it first and the
 * board row follows), so this is the read the owner sync follows. Read-only, never retried here. The reply is only
 * trusted when it names the same sub; nothing else in it (token expiry included) is returned.
 */
export async function readCommsBoardOwnership(
  config: CommsBoardProvisionerConfig,
  request: { baseSub: string },
  fetchImpl: FetchLike = tailnetAwareFetch,
  timeoutMs: number = COMMS_BOARD_REQUEST_TIMEOUT_MS,
): Promise<ReadOwnershipOutcome> {
  if (!BASE_SUB_PATTERN.test(request.baseSub)) return { ok: false, reason: "invalid_subject" };
  let response: Response;
  try {
    response = await fetchImpl(`${config.ownershipApiUrl}/ownership/${encodeURIComponent(request.baseSub)}`, {
      method: "GET",
      headers: { authorization: `Bearer ${config.ownershipApiToken}` },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    return { ok: false, reason: "registry_failed" };
  }
  if (response.status === 404) return { ok: false, reason: "registry_sub_unknown" };
  if (response.status === 401 || response.status === 403) return { ok: false, reason: "registry_rejected" };
  if (response.status !== 200) return { ok: false, reason: "registry_failed" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: "registry_failed" };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, reason: "registry_failed" };
  const { sub, owner_email: ownerEmail, active } = body as Record<string, unknown>;
  if (sub !== request.baseSub || typeof active !== "boolean") return { ok: false, reason: "registry_failed" };
  if (typeof ownerEmail !== "string" || ownerEmail.trim().length === 0) return { ok: false, reason: "registry_failed" };
  return { ok: true, ownerEmail, active };
}
