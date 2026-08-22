import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePaperclipInstanceRootForAdapter } from "@paperclipai/adapter-utils/server-utils";

const CURSOR_HOME_LINK_ENTRIES = [
  "cli-config.json",
  "agent-cli-state.json",
  "skills",
  "skills-cursor",
  "plugins",
  "ai-tracking",
] as const;

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type CursorMcpServerConfig = Record<string, unknown>;

export function resolveManagedCursorRuntimeStateDir(
  env: NodeJS.ProcessEnv,
  companyId: string,
  agentId: string,
): string {
  const instanceRoot = resolvePaperclipInstanceRootForAdapter({
    homeDir: nonEmpty(env.PAPERCLIP_HOME) ?? undefined,
    instanceId: nonEmpty(env.PAPERCLIP_INSTANCE_ID) ?? undefined,
    env,
  });
  return path.join(instanceRoot, "companies", companyId, "agents", agentId, "cursor-runtime");
}

/**
 * Parse adapterConfig.mcpServers into a Cursor mcp.json map.
 * Supports stdio ({command,args,env}) and remote ({url,headers}) shapes.
 */
export function parseAdapterCursorMcpServers(raw: unknown): Record<string, CursorMcpServerConfig> {
  if (!isPlainRecord(raw)) return {};
  const out: Record<string, CursorMcpServerConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = name.trim();
    if (!key || !isPlainRecord(value)) continue;
    const command = nonEmpty(value.command);
    const url = nonEmpty(value.url);
    if (!command && !url) continue;
    const server: CursorMcpServerConfig = { ...value };
    out[key] = server;
  }
  return out;
}

export function mergeCursorMcpServers(input: {
  adapterServers: Record<string, CursorMcpServerConfig>;
  runtimeServers?: Array<{ name: string; url: string; token: string; connectionId: string }>;
}): Record<string, CursorMcpServerConfig> {
  const mcpServers: Record<string, CursorMcpServerConfig> = { ...input.adapterServers };
  const usedNames = new Set(Object.keys(mcpServers));
  for (const server of input.runtimeServers ?? []) {
    let name = server.name.trim() || `gateway-${server.connectionId.slice(0, 8)}`;
    if (usedNames.has(name)) name = `${name}-${server.connectionId.slice(0, 8)}`;
    let suffix = 2;
    while (usedNames.has(name)) {
      name = `${server.name}-${server.connectionId.slice(0, 8)}-${suffix}`;
      suffix += 1;
    }
    usedNames.add(name);
    mcpServers[name] = {
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
    };
  }
  return mcpServers;
}

async function ensureSymlink(target: string, source: string): Promise<void> {
  const existing = await fs.lstat(target).catch(() => null);
  if (existing) {
    if (existing.isSymbolicLink()) {
      const current = await fs.readlink(target).catch(() => null);
      if (current === source) return;
      await fs.unlink(target);
    } else {
      return;
    }
  }
  await fs.symlink(source, target);
}

/**
 * Materialize adapter/runtime MCP servers into an agent-scoped Cursor HOME.
 * Cursor discovers user MCP from `$HOME/.cursor/mcp.json` (not CURSOR_CONFIG_DIR),
 * so when servers are present we isolate HOME for the agent process instead of
 * writing into the shared host ~/.cursor/mcp.json.
 */
export async function prepareCursorMcpHome(input: {
  companyId: string;
  agentId: string;
  mcpServers: Record<string, CursorMcpServerConfig>;
  hostHome?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ homeDir: string; mcpConfigPath: string; serverNames: string[] } | null> {
  const serverNames = Object.keys(input.mcpServers);
  if (serverNames.length === 0) return null;

  const hostHome = path.resolve(input.hostHome ?? os.homedir());
  const stateDir = resolveManagedCursorRuntimeStateDir(
    input.env ?? process.env,
    input.companyId,
    input.agentId,
  );
  const homeDir = path.join(stateDir, "home");
  const cursorDir = path.join(homeDir, ".cursor");
  await fs.mkdir(cursorDir, { recursive: true });

  const hostCursorDir = path.join(hostHome, ".cursor");
  for (const entry of CURSOR_HOME_LINK_ENTRIES) {
    const source = path.join(hostCursorDir, entry);
    const target = path.join(cursorDir, entry);
    const sourceExists = await fs.access(source).then(() => true).catch(() => false);
    if (!sourceExists) continue;
    await ensureSymlink(target, source);
  }

  const mcpConfigPath = path.join(cursorDir, "mcp.json");
  await fs.writeFile(mcpConfigPath, `${JSON.stringify({ mcpServers: input.mcpServers }, null, 2)}\n`, {
    mode: 0o600,
  });
  await fs.chmod(mcpConfigPath, 0o600).catch(() => undefined);

  // Also mirror into agent workspace home when present so operators can inspect
  // the bound config without reading the managed runtime tree.
  return { homeDir, mcpConfigPath, serverNames };
}
