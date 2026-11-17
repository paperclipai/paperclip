import { and, eq } from "drizzle-orm";
import { agentHarnessType } from "@paperclipai/shared";
import { agents, companySecrets, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { isUnreachableTailnetPort } from "./remote-http-fetch.js";
import { composeAgentMemorySub, mintAgentMemoryCredential, resolveCommsBoardProvisionerConfig } from "./comms-board-provisioner-client.js";
import { agentService } from "./agents.js";
import { ownerEmailFor } from "./default-mcp-owner.js";
import type { DefaultMcpSetupHook } from "./default-mcp-setup.js";
import { secretService } from "./secrets.js";

/**
 * Per-agent memory default for new Hermes and Claude local agents (TECH-8409).
 *
 * The memory service lives outside Paperclip. This hook only provisions generic config: it mints an
 * `agent-memory-<agentId>` token through the ownership registry (the same path the comms hook uses), stores it as a
 * company secret, and attaches the harness settings to the agent's adapterConfig. Which env keys and adapterConfig
 * keys an adapter type gets is the small `AGENT_MEMORY_ADAPTER_PROFILES` table below (add a harness in one entry):
 *
 *   hermes_local  env.MEM0_API_KEY (secret reference, never the value), env.MEM0_HOST, env.MEM0_PROXY (optional),
 *                 env.MEM0_USER_ID (the agent id), memoryProvider "mem0", runtimeMemory false (no agent has both the
 *                 in-process mem0 route and this one)
 *   claude_local  env.RH_MEMORY_TOKEN (secret reference), env.RH_MEMORY_URL, env.RH_MEMORY_PROXY (optional)
 *   codex_local   the same RH_MEMORY_* keys as claude_local (the image-baked Codex hook reads them)
 *
 * Disabled unless `PAPERCLIP_AGENT_MEMORY_ENABLED=true` and a valid `PAPERCLIP_AGENT_MEMORY_URL` is set.
 *
 * Retry safety, in the same order as the comms hook: every check that can fail without cost runs BEFORE the mint; a
 * mint checkpoint without a stored secret means the outcome is unknown and is terminal (never re-minted); the token
 * is stored as a secret before anything else, and the adapterConfig stage is a local, idempotent transaction that is
 * retried without repeating any external call. Tokens are never logged or persisted outside the secret store.
 */

export const AGENT_MEMORY_ENTRY_KEY = "agent-memory";
export const AGENT_MEMORY_ENABLED_ENV = "PAPERCLIP_AGENT_MEMORY_ENABLED";
export const AGENT_MEMORY_URL_ENV = "PAPERCLIP_AGENT_MEMORY_URL";
export const AGENT_MEMORY_PROXY_ENV = "PAPERCLIP_AGENT_MEMORY_PROXY";
/**
 * Server-level switch for end-of-turn memory capture on Claude and Codex agents (TECH-8644).
 * Defaults to off (recall-only); set to "on" to retain legacy capture behavior.
 */
export const AGENT_MEMORY_CAPTURE_ENV = "PAPERCLIP_AGENT_MEMORY_CAPTURE";
export const RH_MEMORY_CAPTURE_KEY = "RH_MEMORY_CAPTURE";
/**
 * Extra opt-in for EXISTING agents: when `true` (and the memory settings are valid), the operator-run missing-entry
 * enrollment may add the agent-memory entry to agents that already hold a default-MCP state. New agents never need it.
 */
export const AGENT_MEMORY_BACKFILL_ENABLED_ENV = "PAPERCLIP_AGENT_MEMORY_BACKFILL_ENABLED";
/**
 * The explicit memory tools for Claude and Codex agents (TECH-8832): a per-agent gateway connection to the memory
 * service's MCP endpoint (`memory_search`, `memory_add`, `memory_delete`), next to the recall/capture hooks. Off unless
 * this is `true` AND the memory settings above are valid. Hermes agents have their own mem0 tools and never get it.
 */
export const AGENT_MEMORY_TOOLS_ENTRY_KEY = "agent-memory-tools";
export const AGENT_MEMORY_TOOLS_ENABLED_ENV = "PAPERCLIP_AGENT_MEMORY_TOOLS_ENABLED";

/** The harness-specific part of the provisioning: which keys the agent's adapterConfig receives. */
export interface AgentMemoryAdapterProfile {
  /** env key holding the secret reference to the agent's memory token. */
  tokenEnvKey: string;
  /** env key for the memory service base URL. */
  urlEnvKey: string;
  /** env key for the optional proxy URL. */
  proxyEnvKey: string;
  /** env key for the agent id, when the harness wants one. */
  userIdEnvKey?: string;
  /** Extra top-level adapterConfig keys, merged as is. */
  adapterConfig?: Readonly<Record<string, unknown>>;
}

/** Adapter type -> keys. Codex uses the same RH_MEMORY_* keys as Claude (TECH-8416). */
export const AGENT_MEMORY_ADAPTER_PROFILES: Readonly<Record<string, AgentMemoryAdapterProfile>> = Object.freeze({
  hermes_local: {
    tokenEnvKey: "MEM0_API_KEY",
    urlEnvKey: "MEM0_HOST",
    proxyEnvKey: "MEM0_PROXY",
    userIdEnvKey: "MEM0_USER_ID",
    adapterConfig: { memoryProvider: "mem0", runtimeMemory: false },
  },
  claude_local: {
    tokenEnvKey: "RH_MEMORY_TOKEN",
    urlEnvKey: "RH_MEMORY_URL",
    proxyEnvKey: "RH_MEMORY_PROXY",
  },
  codex_local: {
    tokenEnvKey: "RH_MEMORY_TOKEN",
    urlEnvKey: "RH_MEMORY_URL",
    proxyEnvKey: "RH_MEMORY_PROXY",
  },
});

/**
 * The profile of an agent, keyed by its HARNESS: `agentHarnessType` maps a native-runner agent (`paperclip_runner`) to
 * the harness its config selects (for example provider `acpx` with agent `claude` is `claude_local`), and returns every
 * other adapter type unchanged.
 *
 * Codex is matched by harness, not by adapter type alone: `codex_local`, or a native runner whose provider is `codex`
 * (also the runner default with no provider) or `acpx` with agent `codex`. Every other runner provider and ACP agent
 * (opencode, muse, openai_dot, grok_bot, pi, grok, cursor, copilot) has no profile. Agent creation normalizes a
 * runner config to an explicit `provider: "codex"`, so a new default runner agent is a Codex agent and is enrolled.
 */
export function agentMemoryProfileFor(adapterType: string | null | undefined, adapterConfig?: unknown): AgentMemoryAdapterProfile | null {
  if (!adapterType) return null;
  const config = asRecord(adapterConfig);
  // `agentHarnessType` returns an unknown runner provider string as is, so a provider named after a harness (such as
  // "hermes_local") would borrow that harness's profile. Only the providers that select Claude or Codex may match.
  if (adapterType === "paperclip_runner" && ![undefined, "codex", "acpx"].includes(config.provider as string | undefined)) return null;
  const harness = agentHarnessType(adapterType, config);
  return Object.prototype.hasOwnProperty.call(AGENT_MEMORY_ADAPTER_PROFILES, harness) ? AGENT_MEMORY_ADAPTER_PROFILES[harness]! : null;
}

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

export interface AgentMemoryConfig {
  /** `MEM0_HOST`, without a trailing slash. */
  url: string;
  /** `MEM0_PROXY`, or null when no proxy is configured. */
  proxy: string | null;
}

export type AgentMemoryConfigResult =
  | { ok: true; config: AgentMemoryConfig }
  | { ok: false; reason: "provisioner_not_configured" | "provisioner_config_invalid" };

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/** Absolute https URL (any host, including a tailnet), or http for loopback only. No userinfo, query or fragment. */
function validMemoryUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url || url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return !isUnreachableTailnetPort(url);
  return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase());
}

/** Proxy URL: http(s) or socks5 with a host and optional port. No credentials, path, query or fragment. */
function validProxyUrl(raw: string): boolean {
  const url = parseUrl(raw);
  if (!url || !["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol)) return false;
  if (!url.hostname || url.username || url.password || url.search || url.hash) return false;
  return url.pathname === "" || url.pathname === "/";
}

/**
 * Closed-enum outcome, decided before any call. Not enabled or no URL is "not configured" (a wait); a malformed URL or
 * proxy is "config invalid". Values are read from the given env and trimmed; nothing here is secret.
 */
export function resolveAgentMemoryConfig(env: NodeJS.ProcessEnv = process.env): AgentMemoryConfigResult {
  if (env[AGENT_MEMORY_ENABLED_ENV]?.trim().toLowerCase() !== "true") return { ok: false, reason: "provisioner_not_configured" };
  const url = env[AGENT_MEMORY_URL_ENV]?.trim();
  if (!url) return { ok: false, reason: "provisioner_not_configured" };
  if (!validMemoryUrl(url)) return { ok: false, reason: "provisioner_config_invalid" };
  const proxy = env[AGENT_MEMORY_PROXY_ENV]?.trim() || null;
  if (proxy && !validProxyUrl(proxy)) return { ok: false, reason: "provisioner_config_invalid" };
  return { ok: true, config: { url: url.replace(/\/+$/, ""), proxy: proxy ? proxy.replace(/\/+$/, "") : null } };
}

/** Backfill of existing agents is on only with its own flag AND a valid memory configuration. */
export function agentMemoryBackfillEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_MEMORY_BACKFILL_ENABLED_ENV]?.trim().toLowerCase() === "true" && resolveAgentMemoryConfig(env).ok;
}

/** Whether a NEW agent of this adapter type gets the memory entry at creation (enabled and valid config, profiled adapter). */
export function agentMemoryEligibleForNewAgent(
  adapterType: string | null | undefined,
  adapterConfig: unknown = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return agentMemoryProfileFor(adapterType, adapterConfig) !== null && resolveAgentMemoryConfig(env).ok;
}

/** Tools are on only with their own flag AND a valid memory configuration. */
export function agentMemoryToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[AGENT_MEMORY_TOOLS_ENABLED_ENV]?.trim().toLowerCase() === "true" && resolveAgentMemoryConfig(env).ok;
}

/** Claude and Codex harnesses only: Hermes agents use the mem0 provider's own tools. */
export function agentMemoryToolsHarness(adapterType: string | null | undefined, adapterConfig?: unknown): boolean {
  if (agentMemoryProfileFor(adapterType, adapterConfig) === null) return false;
  const harness = agentHarnessType(adapterType!, asRecord(adapterConfig));
  return harness === "claude_local" || harness === "codex_local";
}

/** Whether a NEW agent of this adapter type gets the memory tools entry at creation. */
export function agentMemoryToolsEligibleForNewAgent(
  adapterType: string | null | undefined,
  adapterConfig: unknown = {},
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return agentMemoryToolsHarness(adapterType, adapterConfig) && agentMemoryToolsEnabled(env);
}

/** The new-agent setup keys to leave out for an agent of this adapter type (memory settings, and the tools). */
export function agentMemoryExcludedSetupKeys(
  adapterType: string | null | undefined,
  adapterConfig: unknown = {},
  env: NodeJS.ProcessEnv = process.env,
): Set<string> {
  const excluded = new Set<string>();
  if (!agentMemoryEligibleForNewAgent(adapterType, adapterConfig, env)) excluded.add(AGENT_MEMORY_ENTRY_KEY);
  if (!agentMemoryToolsEligibleForNewAgent(adapterType, adapterConfig, env)) excluded.add(AGENT_MEMORY_TOOLS_ENTRY_KEY);
  return excluded;
}

/** `2027-03-01T00:00:00+00:00` and friends to one canonical UTC form; null when absent or unparseable. */
export function normalizeIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * The local, idempotent stage: read the agent's adapterConfig, merge the memory settings into `env` (every other key
 * is kept) plus the adapter's extra keys, and write it back through the agent lifecycle module's configuration update
 * (the only owner of adapterConfig writes). That update normalizes the env, records a config revision and syncs the
 * agent's secret bindings, which the token reference needs to resolve at run time. Replaying it writes the same
 * values. Returns false when the agent's adapter type has no profile (nothing is written).
 */
export async function applyAgentMemoryAdapterConfig(
  db: Db,
  input: { companyId: string; agentId: string; secretId: string; config: AgentMemoryConfig; env?: NodeJS.ProcessEnv },
): Promise<boolean> {
  const svc = agentService(db);
  const row = await svc.getById(input.agentId);
  if (!row || row.companyId !== input.companyId) return false;
  const profile = agentMemoryProfileFor(row.adapterType, row.adapterConfig);
  if (!profile) return false;
  const current = asRecord(row.adapterConfig);
  const currentEnv = asRecord(current.env);
  const env: Record<string, unknown> = {
    ...currentEnv,
    [profile.tokenEnvKey]: { type: "secret_ref", secretId: input.secretId, version: "latest" },
    [profile.urlEnvKey]: { type: "plain", value: input.config.url },
  };
  if (profile.userIdEnvKey) env[profile.userIdEnvKey] = { type: "plain", value: input.agentId };
  // No configured proxy leaves whatever the agent already has: every other key is kept.
  if (input.config.proxy) env[profile.proxyEnvKey] = { type: "plain", value: input.config.proxy };

  const harness = agentHarnessType(row.adapterType, current);
  if (harness === "claude_local" || harness === "codex_local") {
    if (!(RH_MEMORY_CAPTURE_KEY in currentEnv)) {
      const serverEnv = input.env ?? process.env;
      if (serverEnv[AGENT_MEMORY_CAPTURE_ENV]?.trim().toLowerCase() !== "on") {
        env[RH_MEMORY_CAPTURE_KEY] = { type: "plain", value: "off" };
      }
    }
  }

  const updated = await svc.update(
    input.agentId,
    { adapterConfig: { ...current, env, ...(profile.adapterConfig ?? {}) } },
    { recordRevision: { source: "default_mcp_agent_memory" } },
  );
  return updated !== null;
}

export const agentMemoryHook: DefaultMcpSetupHook = async (input) => {
  const { db, companyId, agentId, entry } = input;
  const current = input.current();
  let binding = current.binding;

  if (!binding?.secretId && current.setup.mintAttemptedAt) {
    // A checkpoint without its result means a previous attempt's mint outcome is unknown. Terminal, never re-minted.
    return { kind: "error", reason: "mint_unknown" };
  }

  // Everything that can be missing is checked BEFORE any external call, so waiting never leaves an orphan.
  const resolvedMemory = resolveAgentMemoryConfig(input.env);
  if (!resolvedMemory.ok) return { kind: "waiting", reason: resolvedMemory.reason };
  const memoryConfig = resolvedMemory.config;

  const [agentRow] = await db
    .select({ adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);
  if (!agentRow || agentMemoryProfileFor(agentRow.adapterType, agentRow.adapterConfig) === null) return { kind: "error", reason: "adapter_unsupported" };

  if (!binding?.secretId) {
    const ownerEmail = current.ownerUserId ? await ownerEmailFor(db, companyId, current.ownerUserId) : null;
    if (!ownerEmail) return { kind: "waiting", reason: "owner_required" };
    const provisioner = resolveCommsBoardProvisionerConfig(input.env);
    if (!provisioner.ok) return { kind: "waiting", reason: provisioner.reason };

    await input.checkpoint({ mintAttemptedAt: new Date().toISOString() });
    const minted = await mintAgentMemoryCredential(provisioner.config, { agentId, ownerEmail }, input.fetchImpl);
    if (!minted.ok) return { kind: "error", reason: minted.reason };

    let secretId: string;
    try {
      // A crash or restarted setup can leave this agent's own secret behind. `getByKey` hides soft-deleted rows, so look
      // at every row for the key: an active one is rotated to the token just minted; one that is not active was revoked
      // on purpose and is never revived.
      const secretKey = `agent_memory.${agentId}`;
      const rows = await db
        .select({ id: companySecrets.id, status: companySecrets.status, deletedAt: companySecrets.deletedAt, latestVersion: companySecrets.latestVersion })
        .from(companySecrets)
        .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.key, secretKey)));
      if (rows.length > 1) return { kind: "error", reason: "secret_unavailable" };
      const existing = rows[0];
      if (existing) {
        if (existing.status !== "active" || existing.deletedAt) return { kind: "error", reason: "secret_unavailable" };
        await secretService(db).rotate(
          existing.id,
          { value: minted.boardToken, expectedLatestVersion: existing.latestVersion },
          { userId: current.ownerUserId },
        );
        secretId = existing.id;
      } else {
        const secret = await secretService(db).create(
          companyId,
          {
            name: `Agent memory token (agent ${agentId})`,
            key: secretKey,
            provider: "local_encrypted",
            value: minted.boardToken,
            description: `Managed memory service token for agent ${agentId}. Provisioned at agent creation.`,
          },
          { userId: current.ownerUserId },
        );
        secretId = secret.id;
      }
    } catch (err) {
      // The token cannot be fetched again. Only the error class is logged: never a message, key or value.
      logger.warn(
        { agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
        "agent memory token storage failed",
      );
      return { kind: "error", reason: "secret_store_failed" };
    }
    binding = {
      boardAgentId: null,
      baseSub: composeAgentMemorySub(agentId) ?? `agent-memory-${agentId.toLowerCase()}`,
      agentKey: null,
      boardSub: null,
      secretId,
      secretVersion: "latest",
      connectionId: null,
      grantId: null,
      // Normalized so the rotation sweep can compare expiry times as text.
      tokenExpiresAt: normalizeIso(minted.tokenExpiresAt),
    };
    await input.checkpoint({ binding });
  }

  // A deleted or disabled secret is an intentionally revoked credential: never re-minted or recreated.
  const [secretRow] = await db
    .select({ status: companySecrets.status, deletedAt: companySecrets.deletedAt })
    .from(companySecrets)
    .where(and(eq(companySecrets.companyId, companyId), eq(companySecrets.id, binding.secretId!)))
    .limit(1);
  if (!secretRow || secretRow.status !== "active" || secretRow.deletedAt) return { kind: "error", reason: "secret_unavailable" };

  // Token stored: the rest is one local, idempotent, retryable transaction (no external call). Checkpoint errors are
  // raised above, outside this block, so a lost claim is never swallowed here.
  try {
    const applied = await applyAgentMemoryAdapterConfig(db, { companyId, agentId, secretId: binding.secretId!, config: memoryConfig, env: input.env });
    return applied ? { kind: "ready" } : { kind: "error", reason: "adapter_unsupported" };
  } catch (err) {
    logger.warn(
      { agentId, entryKey: entry.key, errorClass: err instanceof Error ? err.constructor.name : typeof err },
      "agent memory adapter config stage failed",
    );
    return { kind: "retry", reason: "binding_failed" };
  }
};
