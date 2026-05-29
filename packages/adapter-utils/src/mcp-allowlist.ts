import fs from "node:fs/promises";
import path from "node:path";

/**
 * Parses, validates and renders MCP allowlists declared per-agent via
 * `adapterConfig.env.MCP_LIST` (CSV of MCP ids registered in the host
 * sidecar `_paperclip/registry.json`).
 *
 * The runtime of each adapter calls into this module before spawning the
 * native CLI: it parses the allowlist, looks up each id in the registry,
 * fails closed on invalid/blocked ids, and renders the native config trees
 * for opencode, codex, gemini and bob, all pointing at
 * `bash <root>/bin/run-mcp.sh <id>`.
 *
 * Empty / unset `MCP_LIST` means "no MCPs written" — not an error.
 */

const TOKEN_RE = /^[a-z0-9][a-z0-9-]*$/;
const SPLIT_RE = /[,\s]+/;

const ALLOWED_STATUSES = new Set([
  "validated",
  "validated-local-contract-no-live-call",
]);

/**
 * Canonical sidecar root + wrapper script paths under the host bind-mount.
 *
 * These exist for ksio.dev's local deployment; any deployment that does
 * not mount `/Users/cassio/mcp-server/_paperclip` must override at least
 * `PAPERCLIP_MCP_REGISTRY_ROOT` (and usually `PAPERCLIP_MCP_RUN_SCRIPT`).
 *
 * `loadMcpRegistry` will refuse to silently produce `unknown_id` errors
 * when the resolved root does not exist; callers that want to disable
 * MCP entirely should leave `MCP_LIST` empty/unset.
 */
const DEFAULT_MCP_REGISTRY_ROOT = "/Users/cassio/mcp-server/_paperclip";
const RUN_MCP_BIN_DEFAULT = `${DEFAULT_MCP_REGISTRY_ROOT}/bin/run-mcp.sh`;

/** Env var that overrides the sidecar root used to load `registry.json`. */
export const PAPERCLIP_MCP_REGISTRY_ROOT_ENV = "PAPERCLIP_MCP_REGISTRY_ROOT";
/** Env var that overrides the wrapper script rendered into native MCP configs. */
export const PAPERCLIP_MCP_RUN_SCRIPT_ENV = "PAPERCLIP_MCP_RUN_SCRIPT";

/**
 * Returns the sidecar root from `PAPERCLIP_MCP_REGISTRY_ROOT` in the supplied
 * env, or the canonical ksio.dev default. Callers should pass a scoped
 * `Record<string, string>` so the resolution stays deterministic.
 */
export function resolveMcpRegistryRootFromEnv(env: Record<string, string | undefined>): string {
  const fromEnv = env[PAPERCLIP_MCP_REGISTRY_ROOT_ENV]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_MCP_REGISTRY_ROOT;
}

/**
 * Returns the wrapper script path from `PAPERCLIP_MCP_RUN_SCRIPT` in the
 * supplied env. When unset, `loadMcpRegistry` callers fall back to
 * `RUN_MCP_BIN_DEFAULT` via `resolveMcpAllowlist`.
 */
export function resolveRunMcpScriptFromEnv(env: Record<string, string | undefined>): string | undefined {
  const fromEnv = env[PAPERCLIP_MCP_RUN_SCRIPT_ENV]?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
}

/**
 * Result of parsing the raw `MCP_LIST` env value.
 *
 * - `ids` are tokens that match `^[a-z0-9][a-z0-9-]*$`. They are not yet
 *   verified against the registry; that happens in `resolveMcpAllowlist`.
 * - `errors` are human-readable messages for tokens that failed shape
 *   validation (e.g. uppercase, leading dash, slashes).
 */
export type ParsedMcpAllowlist = {
  ids: string[];
  errors: string[];
};

/** A single entry as it appears in `registry.json#servers[]`. */
export type McpRegistryServer = {
  id: string;
  status: string;
  manifest?: string;
  displayName?: string;
  sensitivity?: string;
};

/** Subset of the manifest shape that this module reads. */
export type McpManifestEnvironment = {
  requiredNames?: string[];
  optionalNames?: string[];
};

export type McpManifest = {
  id: string;
  status?: string;
  mcp?: {
    transport?: string;
  };
  environment?: McpManifestEnvironment;
};

/**
 * Cached, normalized view of the registry. `loadMcpRegistry` reads
 * `registry.json` plus every referenced `manifests/<id>.json` and merges
 * them into this map for fast lookup.
 */
export type McpRegistry = {
  rootPath: string;
  servers: Map<string, McpRegistryEntry>;
};

export type McpRegistryEntry = {
  id: string;
  status: string;
  manifestPath: string | null;
  manifest: McpManifest | null;
};

export type McpResolutionErrorKind =
  | "invalid_token"
  | "unknown_id"
  | "blocked_status";

export type McpResolutionError = {
  kind: McpResolutionErrorKind;
  token: string;
  message: string;
};

export type McpEntry = {
  id: string;
  status: string;
  requiredEnvNames: string[];
  optionalEnvNames: string[];
  /** Full path to the wrapper script that the native CLI will spawn. */
  runMcpScript: string;
};

export type ResolveMcpAllowlistInput = {
  rawAllowlist: string | undefined | null;
  registry: McpRegistry;
  /** Override the wrapper path (mainly for tests). */
  runMcpScript?: string;
};

export type ResolveMcpAllowlistResult = {
  resolved: McpEntry[];
  errors: McpResolutionError[];
};

/**
 * Splits the raw `MCP_LIST` value on commas / whitespace, drops empty
 * tokens, and reports any token that fails the shape regex.
 *
 * Whitespace and commas are interchangeable so that operators can write
 * either `"jira-ibm,box"` or `"jira-ibm box"` and get the same result.
 */
export function parseMcpAllowlist(raw: string | undefined | null): ParsedMcpAllowlist {
  const ids: string[] = [];
  const errors: string[] = [];
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ids, errors };
  }
  const seen = new Set<string>();
  for (const token of raw.split(SPLIT_RE)) {
    const trimmed = token.trim();
    if (trimmed.length === 0) continue;
    if (!TOKEN_RE.test(trimmed)) {
      errors.push(
        `MCP_LIST: invalid token "${trimmed}" (expected lowercase letters, digits, dashes; must start with letter or digit).`,
      );
      continue;
    }
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    ids.push(trimmed);
  }
  return { ids, errors };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Reads `registry.json` plus each referenced `manifests/<id>.json` from
 * the canonical sidecar root (e.g. `/Users/cassio/mcp-server/_paperclip`).
 * The result is a normalized `McpRegistry` keyed by id.
 *
 * Manifests that fail to read are kept as `null` and surface as
 * `unknown_id` at resolution time only if they were specifically asked for
 * — entries with a `null` manifest still count as "known" with the status
 * read from `registry.json`.
 *
 * Throws `McpRegistryNotFoundError` when `registry.json` is missing under
 * `rootPath`. This is intentional: silently returning an empty registry
 * would cause every `MCP_LIST` token to fail with `unknown_id` and hide
 * the real problem (the override env var was not set, or the sidecar is
 * not mounted in this deployment).
 */
export class McpRegistryNotFoundError extends Error {
  readonly rootPath: string;
  readonly registryPath: string;
  constructor(rootPath: string, registryPath: string) {
    super(
      `MCP_LIST resolution failed: registry.json not found under "${rootPath}". ` +
        `Set ${PAPERCLIP_MCP_REGISTRY_ROOT_ENV} to the path of the _paperclip sidecar ` +
        `for this deployment, or unset MCP_LIST to disable MCP injection.`,
    );
    this.name = "McpRegistryNotFoundError";
    this.rootPath = rootPath;
    this.registryPath = registryPath;
  }
}

export async function loadMcpRegistry(rootPath: string): Promise<McpRegistry> {
  const registryPath = path.join(rootPath, "registry.json");
  const raw = await readJsonFile<{ servers?: McpRegistryServer[] }>(registryPath);
  if (raw === null) {
    throw new McpRegistryNotFoundError(rootPath, registryPath);
  }
  const servers = new Map<string, McpRegistryEntry>();
  if (!Array.isArray(raw.servers)) {
    return { rootPath, servers };
  }
  for (const server of raw.servers) {
    if (!server || typeof server.id !== "string" || typeof server.status !== "string") {
      continue;
    }
    const manifestRel = typeof server.manifest === "string" ? server.manifest : null;
    const manifestPath = manifestRel ? path.join(rootPath, manifestRel) : null;
    const manifest = manifestPath
      ? await readJsonFile<McpManifest>(manifestPath)
      : null;
    servers.set(server.id, {
      id: server.id,
      status: server.status,
      manifestPath,
      manifest,
    });
  }
  return { rootPath, servers };
}

/**
 * Resolves each id from the parsed allowlist against the registry.
 *
 * Fail-closed in three distinct categories:
 *  - `invalid_token`: failed shape validation (forwarded from `parseMcpAllowlist`).
 *  - `unknown_id`: token is not present in `registry.json`.
 *  - `blocked_status`: id exists but its registry status is not in the
 *    allow set (`validated`, `validated-local-contract-no-live-call`).
 */
export function resolveMcpAllowlist(input: ResolveMcpAllowlistInput): ResolveMcpAllowlistResult {
  const parsed = parseMcpAllowlist(input.rawAllowlist);
  const errors: McpResolutionError[] = parsed.errors.map((message) => ({
    kind: "invalid_token",
    token: extractToken(message),
    message,
  }));
  const resolved: McpEntry[] = [];
  const runScript = (input.runMcpScript ?? RUN_MCP_BIN_DEFAULT).trim() || RUN_MCP_BIN_DEFAULT;
  for (const id of parsed.ids) {
    const entry = input.registry.servers.get(id);
    if (!entry) {
      errors.push({
        kind: "unknown_id",
        token: id,
        message: `MCP_LIST: unknown id "${id}" — not registered in registry.json.`,
      });
      continue;
    }
    if (!ALLOWED_STATUSES.has(entry.status)) {
      errors.push({
        kind: "blocked_status",
        token: id,
        message: `MCP_LIST: id "${id}" has status "${entry.status}" — fail-closed (allowed: ${[...ALLOWED_STATUSES].join(", ")}).`,
      });
      continue;
    }
    const requiredEnvNames =
      entry.manifest?.environment?.requiredNames?.filter((name): name is string => typeof name === "string") ?? [];
    const optionalEnvNames =
      entry.manifest?.environment?.optionalNames?.filter((name): name is string => typeof name === "string") ?? [];
    resolved.push({
      id: entry.id,
      status: entry.status,
      requiredEnvNames,
      optionalEnvNames,
      runMcpScript: runScript,
    });
  }
  return { resolved, errors };
}

function extractToken(message: string): string {
  const m = message.match(/"([^"]+)"/);
  return m ? m[1] : "";
}

/** ─── Renderers ────────────────────────────────────────────────────────── */

export type OpencodeMcpServerConfig = {
  type: "local";
  command: string[];
  enabled: true;
};

/**
 * Renders the `mcp` map shape that opencode reads from `opencode.json`.
 * Each id becomes `{ type: "local", command: ["bash", "<run-mcp>", "<id>"], enabled: true }`.
 */
export function renderOpencodeMcp(resolved: McpEntry[]): Record<string, OpencodeMcpServerConfig> {
  const out: Record<string, OpencodeMcpServerConfig> = {};
  for (const entry of resolved) {
    out[entry.id] = {
      type: "local",
      command: ["bash", entry.runMcpScript, entry.id],
      enabled: true,
    };
  }
  return out;
}

/**
 * Renders TOML fragments for codex `~/.codex/config.toml`. Returns the
 * concatenated `[mcp_servers.<id>]` blocks with no trailing newline.
 *
 * The codex CLI accepts `[mcp_servers.<id>]` with `command = "bash"` and
 * `args = ["<run-mcp>", "<id>"]`.
 */
export function renderCodexMcpToml(resolved: McpEntry[]): string {
  const blocks: string[] = [];
  for (const entry of resolved) {
    blocks.push(
      [
        `[mcp_servers.${entry.id}]`,
        `command = "bash"`,
        `args = [${JSON.stringify(entry.runMcpScript)}, ${JSON.stringify(entry.id)}]`,
      ].join("\n"),
    );
  }
  return blocks.join("\n\n");
}

export type GeminiMcpServerConfig = {
  command: string;
  args: string[];
};

/** Renders the `mcpServers` map for gemini `~/.gemini/settings.json`. */
export function renderGeminiMcpSettings(
  resolved: McpEntry[],
): { mcpServers: Record<string, GeminiMcpServerConfig> } {
  const mcpServers: Record<string, GeminiMcpServerConfig> = {};
  for (const entry of resolved) {
    mcpServers[entry.id] = {
      command: "bash",
      args: [entry.runMcpScript, entry.id],
    };
  }
  return { mcpServers };
}

export type BobMcpServerConfig = {
  command: string;
  args: string[];
};

/** Renders the `mcpServers` map for bob `$BOB_HOME/.bob/settings.json`. */
export function renderBobMcpSettings(
  resolved: McpEntry[],
): { mcpServers: Record<string, BobMcpServerConfig> } {
  const mcpServers: Record<string, BobMcpServerConfig> = {};
  for (const entry of resolved) {
    mcpServers[entry.id] = {
      command: "bash",
      args: [entry.runMcpScript, entry.id],
    };
  }
  return { mcpServers };
}

/**
 * Convenience helper used by adapters that have already parsed the env
 * config: returns `null` when the allowlist is empty/unset (so callers can
 * skip MCP rendering entirely), or a resolution result otherwise.
 */
export function resolveMcpAllowlistFromEnv(input: {
  env: Record<string, string | undefined>;
  registry: McpRegistry;
  runMcpScript?: string;
}): ResolveMcpAllowlistResult | null {
  const raw = input.env.MCP_LIST;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return null;
  }
  return resolveMcpAllowlist({
    rawAllowlist: raw,
    registry: input.registry,
    runMcpScript: input.runMcpScript,
  });
}

export const MCP_ALLOWLIST_DEFAULTS = {
  runMcpScript: RUN_MCP_BIN_DEFAULT,
  allowedStatuses: ALLOWED_STATUSES,
} as const;
