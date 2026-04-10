import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ExternalMcpServer = {
  name: string;
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

function nonEmpty(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function escapeTomlString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const headers = Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0)
      .map(([key, headerValue]) => [key, headerValue.trim()]),
  );
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export function resolveConfiguredExternalMcpServers(
  env: NodeJS.ProcessEnv = process.env,
): ExternalMcpServer[] {
  const servers = new Map<string, ExternalMcpServer>();
  const rubeUrl = nonEmpty(env.PAPERCLIP_RUBE_MCP_URL);
  const rubeName = nonEmpty(env.PAPERCLIP_RUBE_MCP_NAME) ?? "rube";
  const rubeHeaders = (() => {
    const raw = nonEmpty(env.PAPERCLIP_RUBE_MCP_HEADERS_JSON);
    if (!raw) return undefined;
    try {
      return normalizeHeaders(JSON.parse(raw));
    } catch {
      return undefined;
    }
  })();

  if (rubeUrl) {
    servers.set(rubeName, {
      name: rubeName,
      type: "http",
      url: rubeUrl,
      headers: rubeHeaders,
    });
  }

  const rawJson = nonEmpty(env.PAPERCLIP_EXTERNAL_MCP_SERVERS_JSON);
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      const candidates = Array.isArray(parsed)
        ? parsed
        : typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
          ? Object.entries(parsed).map(([name, value]) => ({ name, ...(value as Record<string, unknown>) }))
          : [];
      for (const candidate of candidates) {
        const name = nonEmpty((candidate as Record<string, unknown>).name as string | undefined);
        const type = nonEmpty((candidate as Record<string, unknown>).type as string | undefined) ?? "http";
        const url = nonEmpty((candidate as Record<string, unknown>).url as string | undefined);
        if (!name || !url || type !== "http") continue;
        servers.set(name, {
          name,
          type: "http",
          url,
          headers: normalizeHeaders((candidate as Record<string, unknown>).headers),
        });
      }
    } catch {
      // Ignore invalid JSON; startup will continue without external MCP sync.
    }
  }

  return Array.from(servers.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export function mergeClaudeMcpServersJson(
  existingJson: string | null | undefined,
  servers: ExternalMcpServer[],
): string {
  let parsed: Record<string, unknown> = {};
  if (typeof existingJson === "string" && existingJson.trim().length > 0) {
    try {
      const candidate = JSON.parse(existingJson);
      if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
        parsed = candidate as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }
  }

  const mcpServers =
    parsed.mcpServers && typeof parsed.mcpServers === "object" && !Array.isArray(parsed.mcpServers)
      ? { ...(parsed.mcpServers as Record<string, unknown>) }
      : {};

  for (const server of servers) {
    const nextEntry: Record<string, unknown> = {
      type: server.type,
      url: server.url,
    };
    if (server.headers && Object.keys(server.headers).length > 0) {
      nextEntry.headers = server.headers;
    }
    mcpServers[server.name] = nextEntry;
  }

  return `${JSON.stringify({ ...parsed, mcpServers }, null, 2)}\n`;
}

function buildCodexHttpServerBlock(server: ExternalMcpServer): string {
  const lines = [
    `[mcp_servers.${server.name}]`,
    `type = "${escapeTomlString(server.type)}"`,
    `url = "${escapeTomlString(server.url)}"`,
  ];
  if (server.headers && Object.keys(server.headers).length > 0) {
    lines.push(`[mcp_servers.${server.name}.headers]`);
    for (const [key, value] of Object.entries(server.headers).sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`"${escapeTomlString(key)}" = "${escapeTomlString(value)}"`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function mergeCodexConfigToml(
  existingConfig: string | null | undefined,
  servers: ExternalMcpServer[],
): string {
  let nextConfig = typeof existingConfig === "string" ? existingConfig : "";
  if (nextConfig.length > 0 && !nextConfig.endsWith("\n")) {
    nextConfig += "\n";
  }

  for (const server of servers) {
    const block = buildCodexHttpServerBlock(server);
    const pattern = new RegExp(
      `\\[mcp_servers\\.${escapeRegExp(server.name)}\\]\\n[\\s\\S]*?(?=\\n\\[mcp_servers\\.|$)`,
    );
    if (pattern.test(nextConfig)) {
      nextConfig = nextConfig.replace(pattern, block);
      continue;
    }
    if (nextConfig.length > 0 && !nextConfig.endsWith("\n\n")) {
      nextConfig += "\n";
    }
    nextConfig += block;
  }

  return nextConfig;
}

async function readFileIfPresent(target: string): Promise<string | null> {
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
}

async function writeFileIfChanged(target: string, content: string): Promise<boolean> {
  const current = await readFileIfPresent(target);
  if (current === content) return false;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  return true;
}

function resolveSharedCodexHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(nonEmpty(env.CODEX_HOME) ?? path.join(os.homedir(), ".codex"));
}

function resolveSharedClaudeHome(env: NodeJS.ProcessEnv): string {
  return path.resolve(nonEmpty(env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), ".claude"));
}

export async function syncConfiguredExternalMcpServers(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{
  configured: boolean;
  syncedServers: string[];
  updatedCodexConfig: boolean;
  updatedClaudeConfig: boolean;
}> {
  const servers = resolveConfiguredExternalMcpServers(env);
  if (servers.length === 0) {
    return {
      configured: false,
      syncedServers: [],
      updatedCodexConfig: false,
      updatedClaudeConfig: false,
    };
  }

  const codexHome = resolveSharedCodexHome(env);
  const claudeHome = resolveSharedClaudeHome(env);
  const codexConfigPath = path.join(codexHome, "config.toml");
  const claudeConfigPath = path.join(claudeHome, "mcp-servers.json");

  const nextCodex = mergeCodexConfigToml(await readFileIfPresent(codexConfigPath), servers);
  const nextClaude = mergeClaudeMcpServersJson(await readFileIfPresent(claudeConfigPath), servers);

  const [updatedCodexConfig, updatedClaudeConfig] = await Promise.all([
    writeFileIfChanged(codexConfigPath, nextCodex),
    writeFileIfChanged(claudeConfigPath, nextClaude),
  ]);

  return {
    configured: true,
    syncedServers: servers.map((server) => server.name),
    updatedCodexConfig,
    updatedClaudeConfig,
  };
}
