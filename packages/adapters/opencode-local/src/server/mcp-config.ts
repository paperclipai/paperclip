/**
 * Per-run external MCP server injection for OpenCode.
 *
 * The heartbeat layer resolves the agent's `adapterConfig.mcpServers` (secret
 * refs -> plaintext) before invoking the adapter; this module translates that
 * resolved record into OpenCode's `opencode.json` top-level `mcp` shape.
 * `prepareOpenCodeRuntimeConfig` merges the translated servers into the
 * per-run temp runtime config (0600, removed after the run), so resolved
 * env/header values are inlined there and never logged.
 */

export interface ResolvedMcpServerEntry {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  allowedTools?: string[];
}

function asStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Defensively parse `config.mcpServers` as handed to the adapter. Only
 * fully-resolved entries (plain string values) are accepted; unresolved
 * binding objects are ignored so a mis-wired call can't leak refs into args.
 */
export function parseResolvedMcpServers(value: unknown): Record<string, ResolvedMcpServerEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const servers: Record<string, ResolvedMcpServerEntry> = {};
  for (const [name, rawServer] of Object.entries(value as Record<string, unknown>)) {
    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
    const server = rawServer as Record<string, unknown>;
    const transport = server.transport;
    if (transport === "stdio") {
      const command = typeof server.command === "string" ? server.command.trim() : "";
      if (!command) continue;
      servers[name] = {
        transport,
        command,
        args: Array.isArray(server.args)
          ? server.args.filter((arg): arg is string => typeof arg === "string")
          : [],
        env: asStringRecord(server.env),
        timeoutMs: asPositiveNumber(server.timeoutMs),
        allowedTools: Array.isArray(server.allowedTools)
          ? server.allowedTools.filter((tool): tool is string => typeof tool === "string")
          : undefined,
      };
      continue;
    }
    if (transport !== "http" && transport !== "sse") continue;
    const url = typeof server.url === "string" ? server.url.trim() : "";
    if (!url) continue;
    servers[name] = {
      transport,
      url,
      headers: asStringRecord(server.headers),
      timeoutMs: asPositiveNumber(server.timeoutMs),
      allowedTools: Array.isArray(server.allowedTools)
        ? server.allowedTools.filter((tool): tool is string => typeof tool === "string")
        : undefined,
    };
  }
  return servers;
}

/**
 * Translate resolved servers into OpenCode's `opencode.json` top-level `mcp`
 * record. stdio maps to `type: "local"` with `command` as a [program, ...args]
 * array; http/sse map to `type: "remote"` (OpenCode speaks streamable HTTP for
 * both) with `oauth: false` so headless runs never attempt interactive OAuth.
 */
export function buildOpenCodeMcpConfig(
  servers: Record<string, ResolvedMcpServerEntry>,
): Record<string, Record<string, unknown>> {
  const mcp: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === "stdio") {
      mcp[name] = {
        type: "local",
        command: [server.command ?? "", ...(server.args ?? [])],
        ...(server.env && Object.keys(server.env).length > 0
          ? { environment: server.env }
          : {}),
        enabled: true,
        ...(server.timeoutMs ? { timeout: server.timeoutMs } : {}),
      };
      continue;
    }
    mcp[name] = {
      type: "remote",
      url: server.url,
      ...(server.headers && Object.keys(server.headers).length > 0
        ? { headers: server.headers }
        : {}),
      oauth: false,
      enabled: true,
    };
  }
  return mcp;
}
