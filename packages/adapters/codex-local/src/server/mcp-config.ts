import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, withFileLock } from "./fs-atomic.js";

/**
 * Per-run external MCP server injection for the Codex CLI.
 *
 * The heartbeat layer resolves the agent's `adapterConfig.mcpServers` (secret
 * refs -> plaintext) before invoking the adapter; this module translates that
 * resolved record into Codex's `$CODEX_HOME/config.toml` `[mcp_servers.<name>]`
 * tables and merges them into the per-agent Codex home's config.toml.
 *
 * Secrets hygiene: remote-server header values never land in the TOML. Each
 * header is referenced BY ENV VAR NAME (`env_http_headers` /
 * `bearer_token_env_var`) and the plaintext value rides only in the spawn env
 * returned to the caller. stdio env values are written literally into the
 * TOML env subtable — acceptable because the config.toml lives in a
 * per-agent Codex home and is chmodded 0600 after every merge.
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

function asPositiveTimeoutMs(value: unknown): number | undefined {
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
        timeoutMs: asPositiveTimeoutMs(server.timeoutMs),
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
      timeoutMs: asPositiveTimeoutMs(server.timeoutMs),
      allowedTools: Array.isArray(server.allowedTools)
        ? server.allowedTools.filter((tool): tool is string => typeof tool === "string")
        : undefined,
    };
  }
  return servers;
}

/** Value shapes we emit into a `[mcp_servers.<name>]` table. */
export type CodexMcpTomlValue = string | number | string[] | Record<string, string>;

export type CodexMcpServerTable = Record<string, CodexMcpTomlValue>;

export interface CodexMcpConfig {
  /** `[mcp_servers.<name>]` tables keyed by server name. */
  tables: Record<string, CodexMcpServerTable>;
  /**
   * Env vars carrying remote-header secret values, referenced by NAME from
   * `env_http_headers` / `bearer_token_env_var`. Merge into the spawn env
   * only — never into logged or onMeta env.
   */
  spawnEnv: Record<string, string>;
}

function sanitizeEnvVarFragment(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function mcpHeaderEnvVarName(serverName: string, headerName: string): string {
  return `PAPERCLIP_MCP_${sanitizeEnvVarFragment(serverName)}_${sanitizeEnvVarFragment(headerName)}`;
}

function timeoutSecFields(timeoutMs: number | undefined): Record<string, number> {
  if (timeoutMs === undefined) return {};
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  return { startup_timeout_sec: seconds, tool_timeout_sec: seconds };
}

/**
 * Translate resolved servers into Codex `[mcp_servers.<name>]` tables plus
 * the spawn-env record carrying remote header secrets. Header values are
 * never placed into the tables; `Authorization: Bearer <token>` headers use
 * `bearer_token_env_var`, everything else uses `env_http_headers`.
 */
export function buildCodexMcpConfig(
  servers: Record<string, ResolvedMcpServerEntry>,
): CodexMcpConfig {
  const tables: Record<string, CodexMcpServerTable> = {};
  const spawnEnv: Record<string, string> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (server.transport === "stdio") {
      tables[name] = {
        command: server.command ?? "",
        ...(server.args && server.args.length > 0 ? { args: server.args } : {}),
        ...timeoutSecFields(server.timeoutMs),
        default_tools_approval_mode: "auto",
        ...(server.env && Object.keys(server.env).length > 0 ? { env: server.env } : {}),
      };
      continue;
    }
    let bearerTokenEnvVar: string | null = null;
    const envHttpHeaders: Record<string, string> = {};
    for (const [header, value] of Object.entries(server.headers ?? {})) {
      const envVarName = mcpHeaderEnvVarName(name, header);
      if (header === "Authorization" && value.startsWith("Bearer ")) {
        bearerTokenEnvVar = envVarName;
        spawnEnv[envVarName] = value.slice("Bearer ".length);
        continue;
      }
      envHttpHeaders[header] = envVarName;
      spawnEnv[envVarName] = value;
    }
    tables[name] = {
      url: server.url ?? "",
      ...timeoutSecFields(server.timeoutMs),
      default_tools_approval_mode: "auto",
      ...(bearerTokenEnvVar ? { bearer_token_env_var: bearerTokenEnvVar } : {}),
      ...(Object.keys(envHttpHeaders).length > 0 ? { env_http_headers: envHttpHeaders } : {}),
    };
  }
  return { tables, spawnEnv };
}

const TOML_BARE_KEY_RE = /^[A-Za-z0-9_-]+$/;

function tomlBasicString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

function tomlKey(key: string): string {
  return TOML_BARE_KEY_RE.test(key) ? key : tomlBasicString(key);
}

function tomlScalar(value: string | number | string[]): string {
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map((entry) => tomlBasicString(entry)).join(", ")}]`;
  return tomlBasicString(value);
}

/** Serialize the tables into `[mcp_servers.<name>]` TOML blocks. */
export function serializeCodexMcpServerTables(
  tables: Record<string, CodexMcpServerTable>,
): string {
  const blocks: string[] = [];
  for (const [name, table] of Object.entries(tables)) {
    const lines: string[] = [`[mcp_servers.${tomlKey(name)}]`];
    const subtables: Array<[string, Record<string, string>]> = [];
    for (const [key, value] of Object.entries(table)) {
      if (typeof value === "object" && !Array.isArray(value)) {
        subtables.push([key, value]);
        continue;
      }
      lines.push(`${tomlKey(key)} = ${tomlScalar(value)}`);
    }
    for (const [key, entries] of subtables) {
      lines.push("", `[mcp_servers.${tomlKey(name)}.${tomlKey(key)}]`);
      for (const [entryKey, entryValue] of Object.entries(entries)) {
        lines.push(`${tomlKey(entryKey)} = ${tomlBasicString(entryValue)}`);
      }
    }
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

const PAPERCLIP_MCP_BEGIN_MARK = "# >>> paperclip-managed mcp servers >>>";
const PAPERCLIP_MCP_END_MARK = "# <<< paperclip-managed mcp servers <<<";

const MCP_SERVER_TABLE_HEADER_RE =
  /^\s*\[\s*mcp_servers\s*\.\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(?:\]|\.)/;

function unescapeTomlBasicString(value: string): string {
  return value.replace(/\\(u[0-9a-fA-F]{4}|["\\bfnrt])/g, (_match, esc: string) => {
    if (esc.startsWith("u")) return String.fromCodePoint(Number.parseInt(esc.slice(1), 16));
    switch (esc) {
      case "b": return "\b";
      case "f": return "\f";
      case "n": return "\n";
      case "r": return "\r";
      case "t": return "\t";
      default: return esc;
    }
  });
}

function parseMcpServerTableHeaderName(line: string): string | null {
  const match = MCP_SERVER_TABLE_HEADER_RE.exec(line);
  if (!match) return null;
  if (match[1] !== undefined) return unescapeTomlBasicString(match[1]);
  if (match[2] !== undefined) return match[2];
  return match[3] ?? null;
}

/**
 * Merge the injected tables into an existing config.toml. Any previous
 * paperclip-managed marker section is dropped (so servers removed from the
 * agent's config disappear), same-named `[mcp_servers.<name>]` tables are
 * overridden, and every other line of user/seed config is preserved.
 */
export function mergeCodexMcpServersIntoConfigToml(
  existing: string,
  tables: Record<string, CodexMcpServerTable>,
): string {
  const injectedNames = new Set(Object.keys(tables));
  const kept: string[] = [];
  let droppingTable = false;
  let insideMarkerSection = false;
  for (const line of existing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (insideMarkerSection) {
      if (trimmed === PAPERCLIP_MCP_END_MARK) insideMarkerSection = false;
      continue;
    }
    if (trimmed === PAPERCLIP_MCP_BEGIN_MARK) {
      insideMarkerSection = true;
      droppingTable = false;
      continue;
    }
    if (trimmed.startsWith("[")) {
      const serverName = parseMcpServerTableHeaderName(line);
      droppingTable = serverName !== null && injectedNames.has(serverName);
    }
    if (!droppingTable) kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === "") kept.pop();
  const prefix = kept.join("\n");
  // No servers left: drop the managed section entirely (don't re-emit an empty
  // marker block) so removing the last server leaves clean user/seed config.
  if (injectedNames.size === 0) {
    return prefix ? `${prefix}\n` : "";
  }
  const section = [
    PAPERCLIP_MCP_BEGIN_MARK,
    serializeCodexMcpServerTables(tables),
    PAPERCLIP_MCP_END_MARK,
  ].join("\n");
  return prefix ? `${prefix}\n\n${section}\n` : `${section}\n`;
}

/**
 * True when `<codexHome>/config.toml` exists and carries a paperclip-managed
 * marker section. Used to gate the empty-set reconcile so a never-had-MCP home
 * (freshly seeded config, no marker) is a no-op rather than a needless rewrite.
 */
export async function configTomlHasManagedMcpSection(codexHome: string): Promise<boolean> {
  const existing = await fs.readFile(path.join(codexHome, "config.toml"), "utf8").catch(() => "");
  return existing.includes(PAPERCLIP_MCP_BEGIN_MARK);
}

/**
 * Merge the resolved servers into `<codexHome>/config.toml` (0600) and return
 * the spawn-env record carrying remote header secrets. The codexHome must be
 * per-agent scoped — the written file contains stdio env plaintext. An empty
 * server map drops any prior managed section (used to reconcile removals).
 *
 * The read-modify-write is serialized per config path and the rewrite is
 * atomic (temp + rename), so concurrent same-agent runs can't read a torn or
 * empty file.
 */
export async function injectCodexMcpServersIntoConfigToml(input: {
  codexHome: string;
  servers: Record<string, ResolvedMcpServerEntry>;
}): Promise<{ configTomlPath: string; spawnEnv: Record<string, string> }> {
  const { tables, spawnEnv } = buildCodexMcpConfig(input.servers);
  const configTomlPath = path.join(input.codexHome, "config.toml");
  await withFileLock(configTomlPath, async () => {
    const existing = await fs.readFile(configTomlPath, "utf8").catch(() => "");
    const merged = mergeCodexMcpServersIntoConfigToml(existing, tables);
    await fs.mkdir(input.codexHome, { recursive: true });
    await atomicWriteFile(configTomlPath, merged);
    // mode is asserted on create by atomicWriteFile — re-assert after rename
    // in case an older non-0600 file was replaced.
    await fs.chmod(configTomlPath, 0o600).catch(() => undefined);
  });
  return { configTomlPath, spawnEnv };
}
