import type { AdapterRuntimeMcpServer } from "@paperclipai/adapter-utils";
import { isOpenRouterUrl, openRouterAttributionHeaders } from "@paperclipai/adapter-utils/openrouter-attribution";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type PreparedPiRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  /** The managed agent-config dir, or null when no provider config was written. */
  agentConfigDir: string | null;
  cleanup: () => Promise<void>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. an LLM-gateway virtual key) into models.json
// SERVER-SIDE, where the value is reliably present. Pi resolves a provider apiKey
// by trying it as an env var name first, then as a literal -- but the (possibly
// sandboxed) run process env plumbing is not guaranteed to carry the key, so we
// resolve it here. Unresolvable placeholders are left intact; an env var set to
// an empty string counts as unresolvable (the placeholder stays for Pi to try).
function expandEnvPlaceholders<T>(value: T, resolve: (name: string) => string | undefined): T {
  if (typeof value === "string") {
    return value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name: string) => {
      const resolved = resolve(name);
      return resolved !== undefined && resolved.length > 0 ? resolved : match;
    }) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => expandEnvPlaceholders(entry, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = expandEnvPlaceholders(entry, resolve);
    }
    return out as unknown as T;
  }
  return value;
}

type ParsedProviderConfig = {
  providers: Record<string, unknown> | null;
  warning: string | null;
};

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
): ParsedProviderConfig {
  // Unset/empty (or an empty JSON object) is the normal "feature off" case: no warning.
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { providers: null, warning: null };
  }
  // A SET but unusable value is a misconfiguration; surface it so the run does
  // not proceed silently unconfigured and fail later with an opaque
  // model-not-found error pointing nowhere near the env var.
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      return {
        providers: null,
        warning: "PAPERCLIP_PI_PROVIDERS is set but is not a JSON object; custom providers ignored.",
      };
    }
    // Only keep provider entries that are themselves objects; surface the ones
    // we drop so a malformed entry is just as diagnosable as malformed JSON.
    const providers: Record<string, unknown> = {};
    const skipped: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
      else skipped.push(key);
    }
    return {
      providers: Object.keys(providers).length > 0 ? providers : null,
      warning: skipped.length > 0
        ? `PAPERCLIP_PI_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`
        : null,
    };
  } catch {
    return {
      providers: null,
      warning: "PAPERCLIP_PI_PROVIDERS contains invalid JSON; custom providers ignored.",
    };
  }
}

// Materialize custom Pi providers supplied via PAPERCLIP_PI_PROVIDERS (a JSON
// object in Pi's models.json "providers" shape) into a managed agent-config dir.
//
// Pi has no base-url CLI flag or env var: the only mechanism for pointing it at a
// custom/OpenAI- or Anthropic-compatible endpoint is a models.json file in its
// agent config dir, which Pi resolves from $PI_CODING_AGENT_DIR (falling back to
// $HOME/.pi/agent). Pi resolves `--provider P --model M` by an exact (provider,
// model id) match against that registry, so routing a gateway model requires the
// provider entry to enumerate its models explicitly. We accept the providers as
// config (not hard-coded) so the gateway URL, key, and model list stay declarative.
//
// When PAPERCLIP_PI_PROVIDERS is set we write {"providers": ...} to a fresh temp
// dir and point PI_CODING_AGENT_DIR at it; the managed dir intentionally replaces
// the host agent dir (credentials travel inside the providers config itself, via
// a literal apiKey or a server-side-expanded {env:VAR} placeholder). For remote
// execution targets, execute.ts ships the dir to the sandbox as a runtime asset
// and repoints PI_CODING_AGENT_DIR at the in-sandbox copy.
export async function preparePiRuntimeConfig(input: {
  env: Record<string, string>;
}): Promise<PreparedPiRuntimeConfig> {
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const { providers, warning } = parseProviderConfig(
    input.env.PAPERCLIP_PI_PROVIDERS ?? process.env.PAPERCLIP_PI_PROVIDERS,
    resolveEnv,
  );
  if (!providers) {
    return {
      env: input.env,
      notes: warning ? [warning] : [],
      agentConfigDir: null,
      cleanup: async () => {},
    };
  }

  for (const [name, provider] of Object.entries(providers)) {
    if (!isPlainObject(provider)) continue;
    if (isOpenRouterUrl(provider.baseUrl) || (name === "openrouter" && provider.baseUrl === undefined)) {
      provider.headers = openRouterAttributionHeaders(isPlainObject(provider.headers) ? provider.headers as Record<string, string> : {});
      const models = [
        ...(Array.isArray(provider.models) ? provider.models : []),
        ...(isPlainObject(provider.modelOverrides) ? Object.values(provider.modelOverrides) : []),
      ];
      for (const model of models) {
        if (isPlainObject(model)) model.headers = openRouterAttributionHeaders(isPlainObject(model.headers) ? model.headers as Record<string, string> : {});
      }
    }
  }
  const agentConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-agent-config-"));
  try {
    await fs.writeFile(
      path.join(agentConfigDir, "models.json"),
      `${JSON.stringify({ providers }, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    // Never leak the temp dir when the write fails (e.g. disk-full): the
    // caller only receives the cleanup handle on success.
    await fs.rm(agentConfigDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  return {
    env: {
      ...input.env,
      PI_CODING_AGENT_DIR: agentConfigDir,
    },
    notes: [
      ...(warning ? [warning] : []),
      `Injected ${Object.keys(providers).length} custom Pi provider(s) from PAPERCLIP_PI_PROVIDERS into a managed models.json: ${Object.keys(providers).join(", ")}.`,
    ],
    agentConfigDir,
    cleanup: async () => {
      await fs.rm(agentConfigDir, { recursive: true, force: true });
    },
  };
}

type PreparedPiMcpConfig = {
  agentConfigDir: string | null;
  notes: string[];
  cleanup: () => Promise<void>;
};

const PI_MCP_FILE = "mcp.json";
const PI_MCP_MIN_VERSION = [0, 99, 0] as const;

export function piVersionSupportsMcp(versionOutput: string): boolean | null {
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  const version = match.slice(1, 4).map(Number);
  for (let i = 0; i < PI_MCP_MIN_VERSION.length; i += 1) {
    if (version[i] !== PI_MCP_MIN_VERSION[i]) return version[i]! > PI_MCP_MIN_VERSION[i]!;
  }
  return true;
}

export function piMcpUnsupportedNote(versionOutput: string, serverCount: number): string {
  return `Pi ${versionOutput.trim()} has no MCP support (needs ${PI_MCP_MIN_VERSION.join(".")} or later); ${serverCount} Paperclip MCP server(s) were not delivered. Upgrade @earendil-works/pi-coding-agent to use them.`;
}

function buildPiMcpServers(servers: AdapterRuntimeMcpServer[]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  const taken = new Set<string>();
  const key = (name: string) => name.replace(/-/g, "_");
  for (const server of servers) {
    const base = server.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "mcp";
    let name = taken.has(key(base)) ? `${base}-${server.connectionId.slice(0, 8)}` : base;
    for (let suffix = 2; taken.has(key(name)); suffix += 1) {
      name = `${base}-${server.connectionId.slice(0, 8)}-${suffix}`;
    }
    taken.add(key(name));
    mcpServers[name] = {
      url: server.url,
      headers: { Authorization: `Bearer ${server.token}` },
      description: `${server.name} (Paperclip connection)`,
    };
  }
  return mcpServers;
}

async function readMcpServers(file: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return isPlainObject(parsed) && isPlainObject(parsed.mcpServers) ? parsed.mcpServers : {};
  } catch {
    return {};
  }
}

export async function preparePiMcpConfig(input: {
  servers: AdapterRuntimeMcpServer[];
  env: Record<string, string>;
  managedAgentConfigDir: string | null;
  cwd: string;
}): Promise<PreparedPiMcpConfig> {
  if (input.servers.length === 0) {
    return { agentConfigDir: null, notes: [], cleanup: async () => {} };
  }
  const runtimeServers = buildPiMcpServers(input.servers);
  const note = `Injected Paperclip MCP server(s) into Pi mcp.json: ${Object.keys(runtimeServers).join(", ")}.`;

  if (input.managedAgentConfigDir) {
    await fs.writeFile(
      path.join(input.managedAgentConfigDir, PI_MCP_FILE),
      `${JSON.stringify({ mcpServers: runtimeServers }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return { agentConfigDir: input.managedAgentConfigDir, notes: [note], cleanup: async () => {} };
  }

  const home = input.env.HOME || process.env.HOME || os.homedir();
  const configuredDir = input.env.PI_CODING_AGENT_DIR || process.env.PI_CODING_AGENT_DIR;
  const sourceDir = path.resolve(
    input.cwd,
    configuredDir
      ? configuredDir === "~" || configuredDir.startsWith("~/")
        ? path.join(home, configuredDir.slice(1))
        : configuredDir
      : path.join(home, ".pi", "agent"),
  );
  const overlayDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-agent-mcp-"));
  try {
    const entries = await fs.readdir(sourceDir).catch(() => [] as string[]);
    for (const entry of entries) {
      if (entry === PI_MCP_FILE) continue;
      await fs.symlink(path.join(sourceDir, entry), path.join(overlayDir, entry));
    }
    const mcpServers = { ...(await readMcpServers(path.join(sourceDir, PI_MCP_FILE))), ...runtimeServers };
    await fs.writeFile(
      path.join(overlayDir, PI_MCP_FILE),
      `${JSON.stringify({ mcpServers }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch (err) {
    await fs.rm(overlayDir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
  return {
    agentConfigDir: overlayDir,
    notes: [note],
    cleanup: async () => {
      await fs.rm(overlayDir, { recursive: true, force: true });
    },
  };
}
