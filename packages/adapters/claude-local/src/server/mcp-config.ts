import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Per-run external MCP server injection for Claude Code.
 *
 * The heartbeat layer resolves the agent's `adapterConfig.mcpServers` (secret
 * refs -> plaintext) before invoking the adapter; this module translates that
 * resolved record into Claude Code's `.mcp.json` shape, writes it to a
 * run-scoped 0600 file, and produces the CLI flags that make Claude load ONLY
 * these servers (`--mcp-config <file> --strict-mcp-config`) plus the
 * `--allowedTools mcp__<name>__*` patterns that pre-approve their tools in
 * non-interactive runs.
 *
 * The written file contains resolved secrets — callers must clean it up after
 * the run and never log its contents.
 */

export interface ResolvedMcpServerEntry {
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
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
      allowedTools: Array.isArray(server.allowedTools)
        ? server.allowedTools.filter((tool): tool is string => typeof tool === "string")
        : undefined,
    };
  }
  return servers;
}

/** Translate resolved servers into Claude Code's `.mcp.json` document. */
export function buildClaudeMcpConfigDocument(
  servers: Record<string, ResolvedMcpServerEntry>,
): { mcpServers: Record<string, Record<string, unknown>> } {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === "stdio") {
      mcpServers[name] = {
        type: "stdio",
        command: server.command,
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
      continue;
    }
    mcpServers[name] = {
      type: server.transport,
      url: server.url,
      ...(server.headers && Object.keys(server.headers).length > 0
        ? { headers: server.headers }
        : {}),
    };
  }
  return { mcpServers };
}

/**
 * `--allowedTools` patterns pre-approving this run's MCP tools. Servers with
 * an explicit allowlist get `mcp__<name>__<tool>` entries; everything else
 * gets the whole-server wildcard `mcp__<name>__*`.
 */
export function buildClaudeMcpAllowedToolPatterns(
  servers: Record<string, ResolvedMcpServerEntry>,
): string[] {
  const patterns: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    if (server.allowedTools && server.allowedTools.length > 0) {
      for (const tool of server.allowedTools) {
        patterns.push(`mcp__${name}__${tool}`);
      }
    } else {
      patterns.push(`mcp__${name}__*`);
    }
  }
  return patterns;
}

export interface PreparedClaudeMcpConfig {
  /** Absolute local path of the written mcp config file. */
  localFilePath: string;
  /** Local directory to sync as a runtime asset for remote execution. */
  localDir: string;
  /** File name inside the asset dir (stable for remote path joins). */
  fileName: string;
  cleanup: () => Promise<void>;
}

/**
 * Write the run-scoped Claude MCP config file (0600 inside a 0700 temp dir).
 * Contains resolved secrets — always call `cleanup()` after the run.
 */
export async function prepareClaudeMcpConfigFile(input: {
  runId: string;
  servers: Record<string, ResolvedMcpServerEntry>;
}): Promise<PreparedClaudeMcpConfig> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-mcp-"));
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const fileName = `mcp-${input.runId || randomUUID()}.json`;
  const filePath = path.join(dir, fileName);
  const document = buildClaudeMcpConfigDocument(input.servers);
  await fs.writeFile(filePath, JSON.stringify(document, null, 2), { encoding: "utf-8", mode: 0o600 });
  return {
    localFilePath: filePath,
    localDir: dir,
    fileName,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
