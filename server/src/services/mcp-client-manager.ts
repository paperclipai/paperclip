import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// Multi-tenant MCP client manager (NEO-286 D2). Wire layer = official
// @modelcontextprotocol/sdk client; this module owns only the Cortex-specific
// tenant layer. Decision record: docs/mcp-client-decision.md.
//
// This is the D2-1 skeleton: pool keying, invalidation, and transport
// construction are real; connection/health/eviction land in D2-3 (NEO-351).

const MCP_CLIENT_NAME = "paperclip-mcp-client";
const MCP_CLIENT_VERSION = "0.1.0";

// "sse" is ahead of the persisted registry enum (MCP_SERVER_TRANSPORTS is
// still ["stdio", "http"]); the shared enum grows in D2-3 alongside http/sse
// execution.
export type McpClientTransportKind = "http" | "sse" | "stdio";

export interface McpClientTarget {
  companyId: string;
  mcpServerId: string;
  transport: McpClientTransportKind;
  /** http/sse only. */
  endpoint?: string;
  /** stdio only — refused until the D2-6 allowlist gate exists. */
  command?: string;
  args?: string[];
}

export interface PooledMcpClient {
  companyId: string;
  mcpServerId: string;
  client: Client;
  transport: Transport;
  connectedAt: Date;
  lastUsedAt: Date;
}

export interface McpClientPoolStats {
  companies: number;
  clients: number;
}

export type McpClientManagerErrorCode =
  | "not_implemented"
  | "stdio_gated"
  | "invalid_target";

export class McpClientManagerError extends Error {
  readonly code: McpClientManagerErrorCode;

  constructor(code: McpClientManagerErrorCode, message: string) {
    super(message);
    this.name = "McpClientManagerError";
    this.code = code;
  }
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
      return target.transport === "http"
        ? new StreamableHTTPClientTransport(url)
        : new SSEClientTransport(url);
    }
    case "stdio":
      // Company-configured stdio = arbitrary process launch on the
      // control-plane host. Refused at the pool boundary until the D2-6
      // allowlist/approval gate exists (ADR §3).
      throw new McpClientManagerError(
        "stdio_gated",
        `MCP server ${target.mcpServerId} uses stdio transport, which is gated pending the D2-6 allowlist/approval gate`,
      );
  }
}

export interface McpClientManager {
  /**
   * Returns a connected client for (companyId, mcpServerId), connecting
   * lazily on first use. Connection lands in D2-3; until then this always
   * rejects (stdio targets with "stdio_gated", the rest "not_implemented").
   */
  acquire(target: McpClientTarget): Promise<PooledMcpClient>;
  /** Disconnects and drops every pooled client for one company. */
  invalidateCompany(companyId: string): Promise<void>;
  /** Disconnects and drops one server's pooled client, if present. */
  invalidateServer(companyId: string, mcpServerId: string): Promise<void>;
  /** Disconnects everything; the manager stays usable afterwards. */
  shutdown(): Promise<void>;
  stats(): McpClientPoolStats;
}

export function mcpClientManager(): McpClientManager {
  // A pool entry is only reachable through its (companyId, mcpServerId) key —
  // there is deliberately no cross-company iteration surface. This keying is
  // the structural fix for the global plugin-dispatcher tenant leak (NEO-283).
  const pools = new Map<string, Map<string, PooledMcpClient>>();

  async function disconnect(entry: PooledMcpClient): Promise<void> {
    await entry.client.close();
  }

  async function acquire(target: McpClientTarget): Promise<PooledMcpClient> {
    const existing = pools.get(target.companyId)?.get(target.mcpServerId);
    if (existing) {
      existing.lastUsedAt = new Date();
      return existing;
    }
    // Validates the target and enforces the stdio gate before we ever get a
    // connectable transport.
    createTransportForTarget(target);
    void new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
    throw new McpClientManagerError(
      "not_implemented",
      "MCP client connection is not implemented yet (NEO-351 / D2-3)",
    );
  }

  async function invalidateServer(companyId: string, mcpServerId: string): Promise<void> {
    const pool = pools.get(companyId);
    const entry = pool?.get(mcpServerId);
    if (!pool || !entry) return;
    pool.delete(mcpServerId);
    if (pool.size === 0) pools.delete(companyId);
    await disconnect(entry);
  }

  async function invalidateCompany(companyId: string): Promise<void> {
    const pool = pools.get(companyId);
    if (!pool) return;
    pools.delete(companyId);
    await Promise.all([...pool.values()].map(disconnect));
  }

  async function shutdown(): Promise<void> {
    const companyIds = [...pools.keys()];
    await Promise.all(companyIds.map(invalidateCompany));
  }

  function stats(): McpClientPoolStats {
    let clients = 0;
    for (const pool of pools.values()) clients += pool.size;
    return { companies: pools.size, clients };
  }

  return { acquire, invalidateCompany, invalidateServer, shutdown, stats };
}
