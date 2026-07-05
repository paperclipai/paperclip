import type { EnvBinding, SecretVersionSelector } from "./secrets.js";

/**
 * External MCP (Model Context Protocol) server configuration attached to an
 * agent. Stored under `adapterConfig.mcpServers` as a record keyed by server
 * name, mirroring the `mcpServers` shape used by the underlying runtimes
 * (Claude Code, Codex, Cursor, Gemini, OpenCode). Adapters translate this
 * canonical model into their runtime's native config format at spawn time.
 */
export type McpTransport = "stdio" | "http" | "sse";

/**
 * Auth for remote MCP servers.
 * - `bearer`: a static token (usually a secret_ref) sent as
 *   `Authorization: Bearer <token>`.
 * - `oauth`: a Paperclip-brokered OAuth grant. The board connects the server
 *   once in the UI; Paperclip stores + refreshes the access token as a company
 *   secret and injects it as a bearer header at run time. Headless agents
 *   never see an interactive login.
 */
export interface McpServerBearerAuth {
  type: "bearer";
  token: EnvBinding;
}

export interface McpServerOauthAuth {
  type: "oauth";
  /** Company secret holding the brokered token payload. Null until connected. */
  secretId: string | null;
  version?: SecretVersionSelector;
}

export type McpServerAuth = McpServerBearerAuth | McpServerOauthAuth;

interface McpServerBase {
  /** Defaults to true. Disabled servers are kept in config but not injected. */
  enabled?: boolean;
  /** Per-server startup/tool timeout hint, where the runtime supports it. */
  timeoutMs?: number;
  /**
   * Optional allowlist of tool names exposed from this server. When omitted,
   * all tools from the server are allowed (`mcp__<name>__*` for Claude).
   */
  allowedTools?: string[];
}

export interface McpStdioServerConfig extends McpServerBase {
  transport: "stdio";
  command: string;
  args?: string[];
  /** Env for the spawned MCP server process. Values may be secret_refs. */
  env?: Record<string, EnvBinding>;
  cwd?: string;
}

export interface McpRemoteServerConfig extends McpServerBase {
  transport: "http" | "sse";
  url: string;
  /** Request headers. Values may be secret_refs. */
  headers?: Record<string, EnvBinding>;
  auth?: McpServerAuth;
}

export type McpServerConfig = McpStdioServerConfig | McpRemoteServerConfig;

/** `adapterConfig.mcpServers` — record keyed by server name. */
export type McpServersConfig = Record<string, McpServerConfig>;

/**
 * Runtime-resolved variant handed to adapters after secret resolution: every
 * EnvBinding has been resolved to a plaintext string. Adapters must treat
 * these values as sensitive (0600 files in per-agent homes, never logged).
 */
export interface ResolvedMcpStdioServer {
  transport: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  allowedTools?: string[];
}

export interface ResolvedMcpRemoteServer {
  transport: "http" | "sse";
  url: string;
  headers: Record<string, string>;
  timeoutMs?: number;
  allowedTools?: string[];
}

export type ResolvedMcpServer = ResolvedMcpStdioServer | ResolvedMcpRemoteServer;

/** Resolved record keyed by server name; only enabled servers are included. */
export type ResolvedMcpServers = Record<string, ResolvedMcpServer>;
