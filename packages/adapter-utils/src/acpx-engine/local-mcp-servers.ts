import fs from "node:fs/promises";
import path from "node:path";

/**
 * Locally-configured stdio MCP servers.
 *
 * The ACPX engine launches the vendored CLI in headless/SDK mode, which does
 * NOT read the user-scope MCP registry (`~/.claude.json`). Only Paperclip's own
 * managed `http` connections reached `mcpServers`, so any stdio MCP server the
 * host operator configured locally (mem0, browsermcp, ...) was invisible to
 * every Paperclip run.
 *
 * Rather than implicitly inheriting `~/.claude.json` — unreviewable, and shaped
 * by whatever the interactive CLI happened to write — the list is read from an
 * explicit Paperclip-level file that lives OUTSIDE any workspace, so it
 * survives workspace recreation:
 *
 *   <paperclip-instance-root>/mcp-servers.json
 *
 * Shape (mirrors the familiar `.mcp.json` / Claude MCP config):
 *
 *   {
 *     "mcpServers": {
 *       "mem0": {
 *         "type": "stdio",
 *         "command": "/abs/path/to/run.sh",
 *         "args": [],
 *         "env": { "MEM0_PROFILE": "${PAPERCLIP_AGENT_ID}" }
 *       }
 *     }
 *   }
 *
 * `${VAR}` / `$VAR` in `command`, `args`, and `env` values expand against the
 * environment Paperclip already builds for the run, so per-agent values such as
 * `MEM0_USER_ID` resolve without duplicating them per entry.
 */

/** ACP's stdio `McpServer` member — the transport every ACP agent must support. */
export interface LocalStdioMcpServer {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export interface LocalStdioMcpResolution {
  servers: LocalStdioMcpServer[];
  /** Non-fatal problems (bad entry, unknown transport, name collision, unreadable file). */
  warnings: string[];
  /** Config files actually read, in precedence order (lowest first). */
  sources: string[];
}

const EMPTY_RESOLUTION: LocalStdioMcpResolution = { servers: [], warnings: [], sources: [] };

export const LOCAL_MCP_SERVERS_FILENAME = "mcp-servers.json";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Expand `${VAR}` and `$VAR` against `env`. An undefined variable expands to the
 * empty string (matching shell semantics) and is reported by the caller through
 * the "resolved to empty" warning path only when it empties an entire value we
 * need, so a partially-templated arg still works.
 */
function expandEnvRefs(value: string, env: Record<string, string>): string {
  return value.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (match, braced, bare) => {
    const key = (braced ?? bare) as string;
    const resolved = env[key];
    return resolved === undefined ? match : resolved;
  });
}

function parseEntry(input: {
  name: string;
  raw: unknown;
  env: Record<string, string>;
  source: string;
  warnings: string[];
}): LocalStdioMcpServer | null {
  const { name, raw, env, source, warnings } = input;
  if (!isRecord(raw)) {
    warnings.push(`${source}: MCP server '${name}' is not an object; skipped.`);
    return null;
  }
  if (raw.disabled === true) return null;

  // `type` is optional in `.mcp.json` and defaults to stdio. Anything else
  // (http/sse) is Paperclip-managed territory and is not sourced from here.
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "stdio";
  if (type !== "stdio") {
    warnings.push(`${source}: MCP server '${name}' has transport '${type}'; only stdio is sourced locally. Skipped.`);
    return null;
  }

  const commandRaw = typeof raw.command === "string" ? raw.command.trim() : "";
  if (!commandRaw) {
    warnings.push(`${source}: MCP server '${name}' has no 'command'; skipped.`);
    return null;
  }
  const command = expandEnvRefs(commandRaw, env);

  const argsRaw = Array.isArray(raw.args) ? raw.args : [];
  const args: string[] = [];
  for (const arg of argsRaw) {
    if (typeof arg !== "string") {
      warnings.push(`${source}: MCP server '${name}' has a non-string arg; skipped that arg.`);
      continue;
    }
    args.push(expandEnvRefs(arg, env));
  }

  const envEntries: Array<{ name: string; value: string }> = [];
  if (isRecord(raw.env)) {
    for (const [envName, envValue] of Object.entries(raw.env)) {
      if (typeof envValue !== "string") {
        warnings.push(`${source}: MCP server '${name}' env '${envName}' is not a string; skipped.`);
        continue;
      }
      envEntries.push({ name: envName, value: expandEnvRefs(envValue, env) });
    }
    envEntries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  return { name, command, args, env: envEntries };
}

/**
 * Parse a `.mcp.json`-shaped document. Accepts either the wrapped
 * `{ "mcpServers": { name: entry } }` form or a bare `{ name: entry }` map.
 */
export function parseLocalStdioMcpServers(input: {
  document: unknown;
  env?: Record<string, string>;
  source?: string;
}): LocalStdioMcpResolution {
  const env = input.env ?? {};
  const source = input.source ?? "<inline>";
  const warnings: string[] = [];
  if (!isRecord(input.document)) {
    warnings.push(`${source}: expected a JSON object; ignored.`);
    return { servers: [], warnings, sources: [] };
  }
  const map = isRecord(input.document.mcpServers) ? input.document.mcpServers : input.document;
  const servers: LocalStdioMcpServer[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const trimmed = name.trim();
    if (!trimmed) {
      warnings.push(`${source}: MCP server with an empty name; skipped.`);
      continue;
    }
    const parsed = parseEntry({ name: trimmed, raw, env, source, warnings });
    if (parsed) servers.push(parsed);
  }
  servers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { servers, warnings, sources: [] };
}

async function readConfigFile(input: {
  filePath: string;
  env: Record<string, string>;
  required: boolean;
}): Promise<LocalStdioMcpResolution> {
  let text: string;
  try {
    text = await fs.readFile(input.filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && !input.required) return EMPTY_RESOLUTION;
    return {
      servers: [],
      warnings: [`${input.filePath}: unreadable (${String(error)}); ignored.`],
      sources: [],
    };
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return {
      servers: [],
      warnings: [`${input.filePath}: invalid JSON (${String(error)}); ignored.`],
      sources: [],
    };
  }
  const parsed = parseLocalStdioMcpServers({ document, env: input.env, source: input.filePath });
  return { ...parsed, sources: [input.filePath] };
}

/**
 * Resolve the local stdio MCP servers for a run.
 *
 * Precedence (later wins on a name collision):
 *   1. `<instanceRoot>/mcp-servers.json`
 *   2. `PAPERCLIP_MCP_SERVERS_FILE` (explicit override; missing file is an error worth warning about)
 *   3. the adapter's own `mcpServers` config value (per-agent, from the Paperclip adapter settings)
 */
export async function resolveLocalStdioMcpServers(input: {
  instanceRoot: string;
  env: Record<string, string>;
  /** Adapter-config value, if the agent's adapter config carries an `mcpServers` object. */
  adapterConfigValue?: unknown;
  /** Names already claimed by Paperclip-managed connections; those always win. */
  reservedNames?: Iterable<string>;
}): Promise<LocalStdioMcpResolution> {
  const layers: LocalStdioMcpResolution[] = [];

  layers.push(
    await readConfigFile({
      filePath: path.join(input.instanceRoot, LOCAL_MCP_SERVERS_FILENAME),
      env: input.env,
      required: false,
    }),
  );

  const overridePath = input.env.PAPERCLIP_MCP_SERVERS_FILE?.trim();
  if (overridePath) {
    layers.push(await readConfigFile({ filePath: path.resolve(overridePath), env: input.env, required: true }));
  }

  if (input.adapterConfigValue !== undefined && input.adapterConfigValue !== null) {
    layers.push({
      ...parseLocalStdioMcpServers({
        document: input.adapterConfigValue,
        env: input.env,
        source: "adapter config 'mcpServers'",
      }),
      sources: ["adapter config 'mcpServers'"],
    });
  }

  const warnings: string[] = [];
  const sources: string[] = [];
  const byName = new Map<string, LocalStdioMcpServer>();
  for (const layer of layers) {
    warnings.push(...layer.warnings);
    sources.push(...layer.sources);
    for (const server of layer.servers) byName.set(server.name, server);
  }

  const reserved = new Set(input.reservedNames ?? []);
  const servers: LocalStdioMcpServer[] = [];
  for (const server of byName.values()) {
    if (reserved.has(server.name)) {
      warnings.push(
        `MCP server '${server.name}' collides with a Paperclip-managed connection; the managed connection wins.`,
      );
      continue;
    }
    servers.push(server);
  }
  servers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { servers, warnings, sources };
}
