import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";
import { atomicWriteFile, withFileLock } from "./fs-atomic.js";

/**
 * Per-run external MCP server injection for Cursor CLI.
 *
 * The heartbeat layer resolves the agent's `adapterConfig.mcpServers` (secret
 * refs -> plaintext) before invoking the adapter; this module translates that
 * resolved record into Cursor's `~/.cursor/mcp.json` shape. Because Cursor
 * only reads MCP config from `$HOME/.cursor/mcp.json`, local runs with MCP
 * servers get an isolated per-agent HOME under the Paperclip instance root
 * (`agent-homes/<agentId>`) instead of the user's real `~/.cursor` — this
 * keeps agent A's servers invisible to agent B and never touches the user's
 * own mcp.json.
 *
 * The written files contain resolved secrets — they are 0600, per-agent (or
 * per-run temp) scoped, and must never be logged.
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

/**
 * Translate resolved servers into Cursor's `~/.cursor/mcp.json` document.
 * stdio servers use `{ command, args, env }`; remote servers use
 * `{ url, headers }` (Cursor has no transport discriminator for remotes).
 */
export function buildCursorMcpConfigDocument(
  servers: Record<string, ResolvedMcpServerEntry>,
): { mcpServers: Record<string, Record<string, unknown>> } {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === "stdio") {
      mcpServers[name] = {
        command: server.command,
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
      continue;
    }
    mcpServers[name] = {
      url: server.url,
      ...(server.headers && Object.keys(server.headers).length > 0
        ? { headers: server.headers }
        : {}),
    };
  }
  return { mcpServers };
}

/** Per-agent home dir used to isolate Cursor MCP config between agents. */
export function resolveCursorAgentHomeDir(agentId: string, env: NodeJS.ProcessEnv = process.env): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({ env });
  return path.join(instanceRoot, "agent-homes", agentId);
}

/**
 * Provision the per-agent Cursor home for a local run with MCP servers:
 * write `<agentHome>/.cursor/mcp.json` (0600, overwritten each run) and seed
 * the user's `~/.cursor/cli-config.json` auth file into the per-agent
 * `.cursor/` when present (copied fresh each run so refreshed auth
 * propagates). Returns the agent home path to use as the child HOME.
 */
export async function prepareCursorAgentHomeMcpConfig(input: {
  agentId: string;
  servers: Record<string, ResolvedMcpServerEntry>;
  env?: NodeJS.ProcessEnv;
}): Promise<string> {
  const agentHome = resolveCursorAgentHomeDir(input.agentId, input.env ?? process.env);
  const cursorDir = path.join(agentHome, ".cursor");
  await fs.mkdir(cursorDir, { recursive: true });
  await fs.chmod(cursorDir, 0o700).catch(() => undefined);
  const mcpConfigPath = path.join(cursorDir, "mcp.json");
  const document = buildCursorMcpConfigDocument(input.servers);
  // Atomic + serialized: up to 20 concurrent same-agent runs share this file,
  // and a launching Cursor CLI must never read a torn/empty mcp.json.
  await withFileLock(mcpConfigPath, async () => {
    await atomicWriteFile(mcpConfigPath, JSON.stringify(document, null, 2));
    // mode is asserted on create by atomicWriteFile — re-assert after rename.
    await fs.chmod(mcpConfigPath, 0o600).catch(() => undefined);
  });
  const userCliConfigPath = path.join(os.homedir(), ".cursor", "cli-config.json");
  await fs
    .copyFile(userCliConfigPath, path.join(cursorDir, "cli-config.json"))
    .catch(() => undefined);
  return agentHome;
}

/**
 * Reconcile the per-agent Cursor MCP config for a local run with no MCP
 * servers: remove the managed `<agentHome>/.cursor/mcp.json` if present so the
 * old secret-bearing file doesn't persist after the last server is removed.
 * No-op when the file was never written. Returns whether a file was removed.
 */
export async function removeCursorAgentHomeMcpConfig(input: {
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const agentHome = resolveCursorAgentHomeDir(input.agentId, input.env ?? process.env);
  const mcpConfigPath = path.join(agentHome, ".cursor", "mcp.json");
  try {
    await fs.rm(mcpConfigPath);
    return true;
  } catch {
    return false;
  }
}

export interface PreparedCursorMcpConfigAsset {
  /** Local directory to sync as a runtime asset for remote execution. */
  localDir: string;
  /** File name inside the asset dir (stable for remote path joins). */
  fileName: string;
  cleanup: () => Promise<void>;
}

/**
 * Write the mcp.json into a run-scoped temp dir (0600 inside a 0700 dir) so
 * remote runs can ship it as a prepared runtime asset. Contains resolved
 * secrets — always call `cleanup()` after the run.
 */
export async function prepareCursorMcpConfigAsset(
  servers: Record<string, ResolvedMcpServerEntry>,
): Promise<PreparedCursorMcpConfigAsset> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-cursor-mcp-"));
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const fileName = "mcp.json";
  const document = buildCursorMcpConfigDocument(servers);
  await fs.writeFile(path.join(dir, fileName), JSON.stringify(document, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  return {
    localDir: dir,
    fileName,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}
