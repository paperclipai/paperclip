import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

export interface McpServerEntry {
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  enabled?: boolean;
}

export type McpServersMap = Record<string, McpServerEntry>;

/**
 * Parse mcpServers from the generic adapter config object.
 * Returns only enabled servers (enabled defaults to true when omitted).
 */
export function parseMcpServers(
  config: Record<string, unknown>,
): McpServersMap | null {
  const raw = config.mcpServers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const servers = raw as Record<string, unknown>;
  const result: McpServersMap = {};
  let count = 0;
  for (const [name, value] of Object.entries(servers)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const srv = value as McpServerEntry;
    if (srv.enabled === false) continue;
    result[name] = srv;
    count++;
  }
  return count > 0 ? result : null;
}

/**
 * Expand `${VAR_NAME}` references in MCP server env values
 * against the runtime environment.
 */
export function expandMcpEnv(
  servers: McpServersMap,
  runtimeEnv: Record<string, string | undefined>,
): McpServersMap {
  const result: McpServersMap = {};
  for (const [name, srv] of Object.entries(servers)) {
    if (!srv.env) {
      result[name] = srv;
      continue;
    }
    const expandedEnv: Record<string, string> = {};
    for (const [key, val] of Object.entries(srv.env)) {
      expandedEnv[key] = val.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
        return runtimeEnv[varName] ?? "";
      });
    }
    result[name] = { ...srv, env: expandedEnv };
  }
  return result;
}

// ---- Format converters ----

/** Claude Code .mcp.json format */
export function toClaudeMcpJson(servers: McpServersMap): string {
  const mcpServers: Record<string, unknown> = {};
  for (const [name, srv] of Object.entries(servers)) {
    if (srv.transport === "stdio") {
      mcpServers[name] = {
        type: "stdio",
        command: srv.command ?? "",
        args: srv.args ?? [],
        ...(srv.env && Object.keys(srv.env).length > 0 ? { env: srv.env } : {}),
      };
    } else {
      mcpServers[name] = {
        type: "http",
        url: srv.url ?? "",
        ...(srv.headers && Object.keys(srv.headers).length > 0
          ? { headers: srv.headers }
          : {}),
        ...(srv.env && Object.keys(srv.env).length > 0 ? { env: srv.env } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

/** OpenCode opencode.json mcp section format */
export function toOpenCodeMcpJson(servers: McpServersMap): string {
  const mcp: Record<string, unknown> = {};
  for (const [name, srv] of Object.entries(servers)) {
    if (srv.transport === "stdio") {
      mcp[name] = {
        type: "local",
        enabled: true,
        command: [srv.command ?? "", ...(srv.args ?? [])],
        ...(srv.env && Object.keys(srv.env).length > 0 ? { environment: srv.env } : {}),
      };
    } else {
      mcp[name] = {
        type: "remote",
        enabled: true,
        url: srv.url ?? "",
        ...(srv.headers && Object.keys(srv.headers).length > 0
          ? { headers: srv.headers }
          : {}),
        ...(srv.env && Object.keys(srv.env).length > 0 ? { environment: srv.env } : {}),
      };
    }
  }
  return JSON.stringify({ mcp }, null, 2);
}

/** Codex config.toml [mcp_servers.*] format */
export function toCodexToml(servers: McpServersMap): string {
  const lines: string[] = [];
  for (const [name, srv] of Object.entries(servers)) {
    lines.push(`[mcp_servers.${name}]`);
    lines.push(`type = "${srv.transport}"`);
    if (srv.transport === "stdio") {
      lines.push(`command = "${srv.command ?? ""}"`);
      if (srv.args && srv.args.length > 0) {
        const argsStr = srv.args.map((a) => `"${a}"`).join(", ");
        lines.push(`args = [${argsStr}]`);
      }
    } else {
      lines.push(`url = "${srv.url ?? ""}"`);
    }
    if (srv.env && Object.keys(srv.env).length > 0) {
      const envParts = Object.entries(srv.env)
        .map(([k, v]) => `${k} = "${v}"`)
        .join(", ");
      lines.push(`env = { ${envParts} }`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---- Reverse parsers (disk file -> McpServersMap) ----

/** Parse Claude Code / Cursor .mcp.json content -> McpServersMap */
export function fromClaudeMcpJson(content: string): McpServersMap {
  const parsed = JSON.parse(content);
  const raw = parsed?.mcpServers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: McpServersMap = {};
  for (const [name, value] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (!value || typeof value !== "object") continue;
    const type = value.type as string | undefined;
    if (type === "stdio") {
      result[name] = {
        transport: "stdio",
        command: typeof value.command === "string" ? value.command : undefined,
        args: Array.isArray(value.args) ? (value.args as string[]) : undefined,
        env: isStringRecord(value.env) ? value.env : undefined,
        enabled: true,
      };
    } else if (type === "http") {
      result[name] = {
        transport: "http",
        url: typeof value.url === "string" ? value.url : undefined,
        headers: isStringRecord(value.headers) ? value.headers : undefined,
        env: isStringRecord(value.env) ? value.env : undefined,
        enabled: true,
      };
    }
  }
  return result;
}

/** Parse OpenCode opencode.json content -> McpServersMap (extracts `mcp` key only) */
export function fromOpenCodeJson(content: string): McpServersMap {
  const parsed = JSON.parse(content);
  const raw = parsed?.mcp;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: McpServersMap = {};
  for (const [name, value] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (!value || typeof value !== "object") continue;
    const type = value.type as string | undefined;
    const envObj = isStringRecord(value.environment) ? value.environment
      : isStringRecord(value.env) ? value.env
      : undefined;
    const enabled = value.enabled !== false;
    if (type === "local") {
      const cmdArr = Array.isArray(value.command) ? (value.command as string[]) : [];
      result[name] = {
        transport: "stdio",
        command: cmdArr[0] ?? undefined,
        args: cmdArr.length > 1 ? cmdArr.slice(1) : undefined,
        env: envObj,
        enabled,
      };
    } else if (type === "remote") {
      result[name] = {
        transport: "http",
        url: typeof value.url === "string" ? value.url : undefined,
        headers: isStringRecord(value.headers) ? value.headers : undefined,
        env: envObj,
        enabled,
      };
    }
  }
  return result;
}

/** Parse Codex config.toml content -> McpServersMap (best-effort TOML subset) */
export function fromCodexToml(content: string): McpServersMap {
  const result: McpServersMap = {};
  const sectionRe = /^\[mcp_servers\.(\w+)\]\s*$/;
  let current: { name: string; fields: Record<string, string | string[]> } | null = null;

  const flush = () => {
    if (!current) return;
    const { name, fields } = current;
    const transport = (fields.type as unknown as string) === "http" ? "http" as const : "stdio" as const;
    const entry: McpServerEntry = { transport, enabled: true };
    if (transport === "stdio") {
      entry.command = typeof fields.command === "string" ? fields.command : undefined;
      entry.args = Array.isArray(fields.args) ? fields.args : undefined;
    } else {
      entry.url = typeof fields.url === "string" ? fields.url : undefined;
    }
    result[name] = entry;
  };

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    const sectionMatch = sectionRe.exec(trimmed);
    if (sectionMatch) {
      flush();
      current = { name: sectionMatch[1], fields: {} };
      continue;
    }
    if (!current || !trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const rawVal = trimmed.slice(eqIdx + 1).trim();
    if (rawVal.startsWith("[")) {
      const items = rawVal.slice(1, rawVal.lastIndexOf("]"))
        .split(",")
        .map(s => s.trim().replace(/^"|"$/g, ""))
        .filter(Boolean);
      current.fields[key] = items;
    } else {
      current.fields[key] = rawVal.replace(/^"|"$/g, "");
    }
  }
  flush();
  return result;
}

function isStringRecord(v: unknown): v is Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every(val => typeof val === "string");
}

// ---- Adapter -> config file path mapping ----

export type McpConfigFormat = "claude" | "opencode" | "codex" | "cursor";

export interface McpConfigPathInfo {
  filePath: string;
  format: McpConfigFormat;
}

/**
 * Returns the config file path (relative to agent cwd) and format
 * for a given adapter type. Returns null for unsupported adapters.
 */
export function mcpConfigPath(adapterType: string): McpConfigPathInfo | null {
  switch (adapterType) {
    case "claude_local":
      return { filePath: ".mcp.json", format: "claude" };
    case "opencode_local":
      return { filePath: "opencode.json", format: "opencode" };
    case "cursor":
      return { filePath: ".cursor/mcp.json", format: "cursor" };
    case "codex_local":
      return { filePath: "config.toml", format: "codex" };
    case "hermes_local":
      return { filePath: "config.yaml", format: "hermes" as McpConfigFormat };
    default:
      return null;
  }
}

// ---- Temp file helpers ----

/**
 * Write MCP config to a temp file inside an existing directory.
 * Returns the file path. Caller is responsible for cleanup.
 */
export async function writeMcpConfigFile(
  dir: string,
  filename: string,
  content: string,
): Promise<string> {
  const filePath = path.join(dir, filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

/**
 * Write MCP config to a new temp directory.
 * Returns the file path. Caller is responsible for cleanup of parent dir.
 */
export async function writeMcpTempFile(
  prefix: string,
  filename: string,
  content: string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const filePath = path.join(dir, filename);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return { dir, filePath };
}
