import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Multi-tenant MCP client manager (NEO-286 D2). Wire layer = official
// @modelcontextprotocol/sdk client; this module owns only the Cortex-specific
// tenant layer. Decision record: docs/mcp-client-decision.md.
//
// D2-3 (NEO-351): executing http/sse client — lazy connect, per-company pools,
// TTL eviction + idle reaping, listTools health pings, SSRF endpoint guard.
// D2-7 (NEO-355): stdio spawn harness — gated behind stdioEnabled + per-company
// concurrency cap + connect backoff. Callers must verify governance allowlist
// before calling acquire() with transport="stdio".

const MCP_CLIENT_NAME = "paperclip-mcp-client";
const MCP_CLIENT_VERSION = "0.1.0";

const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_REAP_INTERVAL_MS = 30_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;

export type McpClientTransportKind = "http" | "sse" | "stdio";

export interface McpClientTarget {
  companyId: string;
  mcpServerId: string;
  transport: McpClientTransportKind;
  /** http/sse only. */
  endpoint?: string;
  /** Extra headers (e.g. Authorization) applied to every request. */
  headers?: Record<string, string>;
  /** stdio only — process command to spawn. */
  command?: string;
  args?: string[];
  /** stdio only — environment variables injected into the spawned process (credential refs already decrypted by caller). */
  env?: Record<string, string>;
  /** stdio only — working directory for the spawned process. */
  cwd?: string;
}

/**
 * The slice of the SDK `Client` surface the pool hands out. Kept minimal so
 * tests can substitute a fake wire client via `connectClient`.
 */
export interface McpWireClient {
  listTools(): Promise<{ tools: unknown[] }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
  /** Optional discovery surface — present on the real SDK client. */
  listResources?(): Promise<{ resources: unknown[] }>;
  listPrompts?(): Promise<{ prompts: unknown[] }>;
  getServerVersion?(): { name?: string; version?: string } | undefined;
}

export type McpClientHealth = "healthy" | "unhealthy";

export interface PooledMcpClient {
  companyId: string;
  mcpServerId: string;
  transport: McpClientTransportKind;
  client: McpWireClient;
  health: McpClientHealth;
  /** Epoch ms. */
  connectedAt: number;
  lastUsedAt: number;
  lastHealthCheckAt: number;
}

export interface McpClientPoolStats {
  companies: number;
  clients: number;
}

export type McpClientManagerErrorCode =
  | "stdio_gated"
  | "stdio_concurrency_limit"
  | "stdio_backoff"
  | "invalid_target"
  | "endpoint_denied"
  | "connect_timeout"
  | "connect_failed";

export class McpClientManagerError extends Error {
  readonly code: McpClientManagerErrorCode;

  constructor(code: McpClientManagerErrorCode, message: string) {
    super(message);
    this.name = "McpClientManagerError";
    this.code = code;
  }
}

function isPrivateIpv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed — fail closed
  }
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 test-net-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark 198.18/15
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

function isPrivateIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family !== 6) return true; // not an IP at all — fail closed
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return true;
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mappedDotted) return isPrivateIpv4(mappedDotted[1]);
  // URL parsing normalizes mapped addresses to hex groups (::ffff:a00:1).
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mappedHex) {
    const high = Number.parseInt(mappedHex[1], 16);
    const low = Number.parseInt(mappedHex[2], 16);
    return isPrivateIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true; // fe80::/10
  return false;
}

const DENIED_HOSTNAME_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * SSRF guard: rejects endpoints that point at internal/loopback/link-local
 * ranges before we ever open a connection. Hostnames are resolved and every
 * returned address is checked; resolution failure fails closed. (This is the
 * connect-time deny-list from plan §4 — it does not pin the resolved address,
 * so DNS-rebinding hardening stays a follow-up for the D2 security pass.)
 */
export async function assertMcpEndpointAllowed(
  endpoint: string,
  options: { allowPrivateEndpoints?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new McpClientManagerError("invalid_target", `Invalid MCP endpoint URL: ${endpoint}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpClientManagerError(
      "endpoint_denied",
      `MCP endpoint protocol "${url.protocol}" is not allowed (http/https only)`,
    );
  }
  if (options.allowPrivateEndpoints) return url;

  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const deny = (reason: string): never => {
    throw new McpClientManagerError(
      "endpoint_denied",
      `MCP endpoint ${endpoint} is denied: ${reason}`,
    );
  };

  if (!hostname) deny("empty hostname");
  if (hostname === "localhost" || DENIED_HOSTNAME_SUFFIXES.some((s) => hostname.endsWith(s))) {
    deny(`hostname "${hostname}" targets an internal zone`);
  }
  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) deny(`address ${hostname} is in a private/internal range`);
    return url;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    return deny(`hostname "${hostname}" could not be resolved`);
  }
  if (addresses.length === 0) deny(`hostname "${hostname}" resolved to no addresses`);
  for (const { address } of addresses) {
    if (isPrivateIpAddress(address)) {
      deny(`hostname "${hostname}" resolves to private/internal address ${address}`);
    }
  }
  return url;
}

function mergeHeaders(base: HeadersInit | undefined, extra: Record<string, string>): Headers {
  const headers = new Headers(base);
  for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  return headers;
}

export function createTransportForTarget(target: McpClientTarget): Transport {
  switch (target.transport) {
    case "http":
    case "sse": {
      if (!target.endpoint) {
        throw new McpClientManagerError(
          "invalid_target",
          `MCP server ${target.mcpServerId} has transport "${target.transport}" but no endpoint`,
        );
      }
      const url = new URL(target.endpoint);
      const headers = target.headers ?? {};
      if (target.transport === "http") {
        return new StreamableHTTPClientTransport(url, {
          requestInit: { headers: mergeHeaders(undefined, headers) },
        });
      }
      // SSE opens its stream through the transport's fetch, which does not
      // apply requestInit — inject headers into every request via fetch.
      return new SSEClientTransport(url, {
        requestInit: { headers: mergeHeaders(undefined, headers) },
        fetch: (input, init) =>
          fetch(input, { ...init, headers: mergeHeaders(init?.headers, headers) }),
      });
    }
    case "stdio": {
      if (!target.command) {
        throw new McpClientManagerError(
          "invalid_target",
          `MCP server ${target.mcpServerId} has transport "stdio" but no command`,
        );
      }
      // Credentials arrive pre-decrypted in target.env — never logged, never
      // written to disk. stderr is piped to suppress output from the child
      // appearing on the parent process's stderr stream.
      return new StdioClientTransport({
        command: target.command,
        args: target.args ?? [],
        env: target.env,
        cwd: target.cwd,
        stderr: "pipe",
      });
    }
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface McpClientManagerOptions {
  /** Max connection age before eviction. */
  ttlMs?: number;
  /** Max time since last use before eviction. */
  idleMs?: number;
  /** 0 disables the background reap timer (call `reap()` manually). */
  reapIntervalMs?: number;
  /** 0 disables the background health timer (call `checkHealth()` manually). */
  healthCheckIntervalMs?: number;
  connectTimeoutMs?: number;
  healthCheckTimeoutMs?: number;
  /** Disables the SSRF guard — tests and explicitly-trusted deployments only. */
  allowPrivateEndpoints?: boolean;
  /**
   * Enables stdio transport. Off by default. Callers must verify the server's
   * governance status is "allowlisted" before calling acquire() with stdio.
   */
  stdioEnabled?: boolean;
  /**
   * Max concurrent live stdio connections per company. Default 5.
   * Prevents a single tenant from exhausting file descriptors.
   */
  stdioMaxPerCompany?: number;
  /**
   * Minimum delay (ms) before retrying a stdio server that just failed to
   * connect. Default 5 000 ms. Prevents hot-loops on a broken command.
   */
  stdioConnectBackoffMs?: number;
  /** Injectable clock (epoch ms) for deterministic eviction tests. */
  now?: () => number;
  /** Injectable wire-connect factory; production uses the official SDK. */
  connectClient?: (target: McpClientTarget) => Promise<McpWireClient>;
}

export interface McpClientManager {
  /**
   * Returns a connected, healthy client for (companyId, mcpServerId),
   * connecting lazily on first use and reconnecting after eviction.
   */
  acquire(target: McpClientTarget): Promise<PooledMcpClient>;
  /** Evicts entries past their TTL or idle deadline. Returns evicted count. */
  reap(): Promise<number>;
  /**
   * listTools-pings every pooled client; failures are marked unhealthy and
   * evicted so the next acquire lazily reconnects.
   */
  checkHealth(): Promise<{ checked: number; evicted: number }>;
  /** Disconnects and drops every pooled client for one company. */
  invalidateCompany(companyId: string): Promise<void>;
  /** Disconnects and drops one server's pooled client, if present. */
  invalidateServer(companyId: string, mcpServerId: string): Promise<void>;
  /** Disconnects everything and stops timers; the manager stays usable. */
  shutdown(): Promise<void>;
  stats(): McpClientPoolStats;
}

const DEFAULT_STDIO_MAX_PER_COMPANY = 5;
const DEFAULT_STDIO_CONNECT_BACKOFF_MS = 5_000;

export function mcpClientManager(options: McpClientManagerOptions = {}): McpClientManager {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const reapIntervalMs = options.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
  const healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  const stdioEnabled = options.stdioEnabled ?? false;
  const stdioMaxPerCompany = options.stdioMaxPerCompany ?? DEFAULT_STDIO_MAX_PER_COMPANY;
  const stdioConnectBackoffMs = options.stdioConnectBackoffMs ?? DEFAULT_STDIO_CONNECT_BACKOFF_MS;
  const now = options.now ?? (() => Date.now());

  // A pool entry is only reachable through its (companyId, mcpServerId) key —
  // there is deliberately no cross-company iteration surface. This keying is
  // the structural fix for the global plugin-dispatcher tenant leak (NEO-283).
  const pools = new Map<string, Map<string, PooledMcpClient>>();
  // Dedupes concurrent connects to the same (companyId, mcpServerId).
  const connecting = new Map<string, Promise<PooledMcpClient>>();
  // Tracks stdio concurrency per company: how many live stdio connections exist.
  const stdioCountByCompany = new Map<string, number>();
  // Last connect-failure timestamp per poolKey — enforces stdioConnectBackoffMs.
  const stdioFailedAt = new Map<string, number>();
  let reapTimer: NodeJS.Timeout | undefined;
  let healthTimer: NodeJS.Timeout | undefined;

  function poolKey(companyId: string, mcpServerId: string): string {
    return `${companyId} ${mcpServerId}`;
  }

  function ensureTimers(): void {
    if (reapIntervalMs > 0 && !reapTimer) {
      reapTimer = setInterval(() => {
        void reap().catch(() => {});
      }, reapIntervalMs);
      reapTimer.unref?.();
    }
    if (healthCheckIntervalMs > 0 && !healthTimer) {
      healthTimer = setInterval(() => {
        void checkHealth().catch(() => {});
      }, healthCheckIntervalMs);
      healthTimer.unref?.();
    }
  }

  function stopTimers(): void {
    if (reapTimer) clearInterval(reapTimer);
    if (healthTimer) clearInterval(healthTimer);
    reapTimer = undefined;
    healthTimer = undefined;
  }

  async function closeQuietly(entry: PooledMcpClient): Promise<void> {
    try {
      await entry.client.close();
    } catch {
      // Already-broken connections are expected to fail to close cleanly.
    }
  }

  function stdioCountIncrement(companyId: string): void {
    stdioCountByCompany.set(companyId, (stdioCountByCompany.get(companyId) ?? 0) + 1);
  }

  function stdioCountDecrement(companyId: string): void {
    const current = stdioCountByCompany.get(companyId) ?? 0;
    const next = current - 1;
    if (next <= 0) stdioCountByCompany.delete(companyId);
    else stdioCountByCompany.set(companyId, next);
  }

  /** Removes the entry from the pool and closes it. */
  async function evict(entry: PooledMcpClient): Promise<void> {
    const pool = pools.get(entry.companyId);
    if (pool?.get(entry.mcpServerId) === entry) {
      pool.delete(entry.mcpServerId);
      if (pool.size === 0) pools.delete(entry.companyId);
      if (entry.transport === "stdio") stdioCountDecrement(entry.companyId);
    }
    await closeQuietly(entry);
  }

  function isExpired(entry: PooledMcpClient, at: number): boolean {
    return at - entry.connectedAt > ttlMs || at - entry.lastUsedAt > idleMs;
  }

  async function connectWire(target: McpClientTarget): Promise<McpWireClient> {
    if (options.connectClient) return options.connectClient(target);
    const client = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
    const transport = createTransportForTarget(target);
    await client.connect(transport);
    return client;
  }

  async function acquire(target: McpClientTarget): Promise<PooledMcpClient> {
    const isStdio = target.transport === "stdio";

    if (isStdio) {
      if (!stdioEnabled) {
        throw new McpClientManagerError(
          "stdio_gated",
          `MCP server ${target.mcpServerId} uses stdio transport, which requires explicit stdioEnabled=true (D2-7 gate)`,
        );
      }
      if (!target.command) {
        throw new McpClientManagerError(
          "invalid_target",
          `MCP server ${target.mcpServerId} has transport "stdio" but no command`,
        );
      }
    } else if (!target.endpoint) {
      throw new McpClientManagerError(
        "invalid_target",
        `MCP server ${target.mcpServerId} has transport "${target.transport}" but no endpoint`,
      );
    }
    ensureTimers();

    const at = now();
    const existing = pools.get(target.companyId)?.get(target.mcpServerId);
    if (existing) {
      if (existing.health === "healthy" && !isExpired(existing, at)) {
        existing.lastUsedAt = at;
        return existing;
      }
      await evict(existing);
    }

    const key = poolKey(target.companyId, target.mcpServerId);
    const inFlight = connecting.get(key);
    if (inFlight) return inFlight;

    const connectPromise = (async () => {
      if (isStdio) {
        // Backoff: block reconnects too soon after a failed connect.
        const failedAt = stdioFailedAt.get(key);
        if (failedAt !== undefined && at - failedAt < stdioConnectBackoffMs) {
          throw new McpClientManagerError(
            "stdio_backoff",
            `MCP server ${target.mcpServerId} is in backoff after a recent connect failure (retry after ${stdioConnectBackoffMs}ms)`,
          );
        }
        // Concurrency cap: limit live stdio connections per company.
        const activeCount = stdioCountByCompany.get(target.companyId) ?? 0;
        if (activeCount >= stdioMaxPerCompany) {
          throw new McpClientManagerError(
            "stdio_concurrency_limit",
            `MCP server ${target.mcpServerId}: company ${target.companyId} has reached the stdio concurrency limit (${stdioMaxPerCompany})`,
          );
        }
      } else {
        // SSRF guard sits at the pool boundary, ahead of any wire activity.
        await assertMcpEndpointAllowed(target.endpoint as string, {
          allowPrivateEndpoints: options.allowPrivateEndpoints,
        });
      }

      let client: McpWireClient;
      try {
        client = await withTimeout(
          connectWire(target),
          connectTimeoutMs,
          () =>
            new McpClientManagerError(
              "connect_timeout",
              `Timed out connecting to MCP server ${target.mcpServerId} after ${connectTimeoutMs}ms`,
            ),
        );
      } catch (error) {
        if (isStdio) stdioFailedAt.set(key, now());
        if (error instanceof McpClientManagerError) throw error;
        throw new McpClientManagerError(
          "connect_failed",
          `Failed to connect to MCP server ${target.mcpServerId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      const connectedAt = now();
      const entry: PooledMcpClient = {
        companyId: target.companyId,
        mcpServerId: target.mcpServerId,
        transport: target.transport,
        client,
        health: "healthy",
        connectedAt,
        lastUsedAt: connectedAt,
        lastHealthCheckAt: connectedAt,
      };
      let pool = pools.get(target.companyId);
      if (!pool) {
        pool = new Map();
        pools.set(target.companyId, pool);
      }
      pool.set(target.mcpServerId, entry);
      if (isStdio) {
        stdioCountIncrement(target.companyId);
        stdioFailedAt.delete(key);
      }
      return entry;
    })().finally(() => {
      connecting.delete(key);
    });
    connecting.set(key, connectPromise);
    return connectPromise;
  }

  function allEntries(): PooledMcpClient[] {
    const entries: PooledMcpClient[] = [];
    for (const pool of pools.values()) entries.push(...pool.values());
    return entries;
  }

  async function reap(): Promise<number> {
    const at = now();
    const expired = allEntries().filter((entry) => isExpired(entry, at));
    await Promise.all(expired.map(evict));
    return expired.length;
  }

  async function checkHealth(): Promise<{ checked: number; evicted: number }> {
    const entries = allEntries();
    let evicted = 0;
    await Promise.all(
      entries.map(async (entry) => {
        try {
          await withTimeout(
            entry.client.listTools(),
            healthCheckTimeoutMs,
            () => new Error(`health ping timed out after ${healthCheckTimeoutMs}ms`),
          );
          entry.health = "healthy";
          entry.lastHealthCheckAt = now();
        } catch {
          entry.health = "unhealthy";
          evicted += 1;
          await evict(entry);
        }
      }),
    );
    return { checked: entries.length, evicted };
  }

  async function invalidateServer(companyId: string, mcpServerId: string): Promise<void> {
    const entry = pools.get(companyId)?.get(mcpServerId);
    if (entry) await evict(entry);
  }

  async function invalidateCompany(companyId: string): Promise<void> {
    const pool = pools.get(companyId);
    if (!pool) return;
    pools.delete(companyId);
    await Promise.all([...pool.values()].map(closeQuietly));
  }

  async function shutdown(): Promise<void> {
    stopTimers();
    const companyIds = [...pools.keys()];
    await Promise.all(companyIds.map(invalidateCompany));
  }

  function stats(): McpClientPoolStats {
    let clients = 0;
    for (const pool of pools.values()) clients += pool.size;
    return { companies: pools.size, clients };
  }

  return { acquire, reap, checkHealth, invalidateCompany, invalidateServer, shutdown, stats };
}

// Process-wide manager used by services that execute MCP tools. Kept lazy so
// importing this module never starts timers; the PAPERCLIP_MCP_CLIENT_ENABLED
// flag continues to gate all callers (see mcp-client-flag.ts).
let sharedManager: McpClientManager | undefined;

export function getSharedMcpClientManager(): McpClientManager {
  if (!sharedManager) {
    sharedManager = mcpClientManager({
      allowPrivateEndpoints:
        process.env.PAPERCLIP_MCP_CLIENT_ALLOW_PRIVATE_ENDPOINTS === "true",
      stdioEnabled:
        process.env.PAPERCLIP_MCP_CLIENT_STDIO_ENABLED === "true",
    });
  }
  return sharedManager;
}
