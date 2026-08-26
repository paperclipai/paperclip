import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import { validateProviderSchemaContract } from "./provider-schema.js";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  /**
   * Per-run runtime diagnostics for cost review: BEFORE/AFTER tool-surface
   * measurement (and removals) surfaced with the invocation meta as
   * `runtimeDiagnostics.mcp.serverNames`. Empty when no MCP map is configured.
   */
  runtimeDiagnostics: OpenCodeRuntimeDiagnostics;
  cleanup: () => Promise<void>;
};

export interface OpenCodeRuntimeDiagnostics {
  mcp?: {
    serverNames: {
      before: string[];
      after: string[];
    };
    removedByAllowlist: string[];
    removedByDenylist: string[];
    removedAsAliases: string[];
  };
}

export interface OpenCodeMcpToolSurfaceFilter {
  /** When set, only these MCP server keys stay enabled for the run. */
  allowlist: ReadonlySet<string> | null;
  /** MCP server keys dropped even when no allowlist is configured. */
  denylist: ReadonlySet<string>;
  active: boolean;
}

function parseNameList(value: unknown): string[] | null {
  let entries: unknown[];
  if (typeof value === "string") {
    entries = value.split(",");
  } else if (Array.isArray(value)) {
    entries = value;
  } else {
    return null;
  }
  const names = entries
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
  return names.length > 0 ? Array.from(new Set(names)) : null;
}

/**
 * Resolve the per-run MCP tool-surface filter from agent config
 * (`toolSurface.mcpAllowlist` / `toolSurface.mcpDenylist`) or run env
 * (`PAPERCLIP_OPENCODE_MCP_ALLOWLIST` / `PAPERCLIP_OPENCODE_MCP_DENYLIST`).
 * Unset on both sides means "no filtering": every configured server stays
 * enabled, preserving existing behavior. A scoped Engineer Paperclip Ops run
 * uses this to keep unrelated Cloudflare/Playwright/Shadcn/Storybook
 * connections out of the generated runtime surface.
 */
export function resolveOpenCodeMcpToolSurfaceFilter(input: {
  config: Record<string, unknown>;
  env: Record<string, string | undefined>;
}): OpenCodeMcpToolSurfaceFilter {
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const rawToolSurface = isPlainObject(input.config.toolSurface) ? input.config.toolSurface : {};
  const rawAllowlist =
    parseNameList(rawToolSurface.mcpAllowlist) ?? parseNameList(resolveEnv("PAPERCLIP_OPENCODE_MCP_ALLOWLIST"));
  const rawDenylist =
    parseNameList(rawToolSurface.mcpDenylist) ?? parseNameList(resolveEnv("PAPERCLIP_OPENCODE_MCP_DENYLIST"));
  const denylist = new Set(rawDenylist ?? []);
  const allowlist = rawAllowlist ? new Set(rawAllowlist) : null;
  return { allowlist, denylist, active: allowlist !== null || denylist.size > 0 };
}

/** Stable identity of an MCP server definition used to collapse duplicates. */
function mcpServerSignature(entry: unknown): string {
  if (!isPlainObject(entry)) return typeof entry === "string" ? `raw:${entry}` : "unknown";
  if (typeof entry.url === "string" && entry.url.trim()) {
    return `remote:${entry.type === "string" ? entry.type : ""}:${entry.url.trim()}`;
  }
  if (typeof entry.command === "string" && entry.command.trim()) {
    return `local:${entry.command.trim()}:${JSON.stringify(Array.isArray(entry.args) ? entry.args : [])}`;
  }
  return `json:${JSON.stringify(entry)}`;
}

export interface AppliedOpenCodeMcpToolSurfaceResult {
  next: Record<string, unknown> | null;
  beforeCount: number;
  afterCount: number;
  beforeServerNames: string[];
  afterServerNames: string[];
  removedByAllowlist: string[];
  removedByDenylist: string[];
  removedAsAliases: string[];
}

/**
 * Apply the resolved filter to an opencode.json `mcp` map and collapse
 * compatibility aliases: multiple keys pointing at the identical server
 * definition keep only one canonical entry (the lexicographically first key),
 * so the model sees a single execution path instead of duplicated tools.
 * Alias collapsing only happens when a filter is explicitly configured.
 */
export function applyOpenCodeMcpToolSurface(
  mcp: unknown,
  filter: OpenCodeMcpToolSurfaceFilter,
): AppliedOpenCodeMcpToolSurfaceResult {
  const result: AppliedOpenCodeMcpToolSurfaceResult = {
    next: null,
    beforeCount: 0,
    afterCount: 0,
    beforeServerNames: [],
    afterServerNames: [],
    removedByAllowlist: [],
    removedByDenylist: [],
    removedAsAliases: [],
  };
  if (!isPlainObject(mcp)) return result;

  const entries = Object.entries(mcp).filter(([, value]) => value !== null && value !== undefined);
  result.beforeCount = entries.length;
  result.beforeServerNames = entries.map(([key]) => key);

  const filtered = entries.filter(([key]) => {
    if (filter.allowlist && !filter.allowlist.has(key)) {
      result.removedByAllowlist.push(key);
      return false;
    }
    if (filter.denylist.has(key)) {
      result.removedByDenylist.push(key);
      return false;
    }
    return true;
  });

  const kept = [...filtered];
  if (filter.active && filtered.length > 1) {
    const canonicalByKey = new Map<string, string>();
    const sortedKeys = filtered.map(([key]) => key).sort();
    const entryByKey = new Map(filtered);
    for (const key of sortedKeys) {
      const signature = mcpServerSignature(entryByKey.get(key));
      const canonical = canonicalByKey.get(signature);
      if (canonical === undefined) {
        canonicalByKey.set(signature, key);
        continue;
      }
      result.removedAsAliases.push(`${key} (= ${canonical})`);
    }
    const aliased = new Set(result.removedAsAliases.map((alias) => alias.split(" ")[0]));
    const nextEntries = filtered.filter(([key]) => !aliased.has(key));
    kept.length = 0;
    kept.push(...nextEntries);
  }

  // Null means "no change": callers leave the configured mcp map untouched.
  result.next = kept.length !== entries.length ? Object.fromEntries(kept) : null;
  result.afterCount = kept.length;
  result.afterServerNames = kept.map(([key]) => key);
  return result;
}

function openCodeRuntimeDiagnosticsFromToolSurface(
  toolSurfaceResult: AppliedOpenCodeMcpToolSurfaceResult,
): OpenCodeRuntimeDiagnostics {
  if (toolSurfaceResult.beforeCount === 0) return {};
  return {
    mcp: {
      serverNames: {
        before: [...toolSurfaceResult.beforeServerNames],
        after: [...toolSurfaceResult.afterServerNames],
      },
      removedByAllowlist: [...toolSurfaceResult.removedByAllowlist],
      removedByDenylist: [...toolSurfaceResult.removedByDenylist],
      removedAsAliases: [...toolSurfaceResult.removedAsAliases],
    },
  };
}

function resolveXdgConfigHome(env: Record<string, string>): string {
  return (
    (typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()) ||
    (typeof process.env.XDG_CONFIG_HOME === "string" && process.env.XDG_CONFIG_HOME.trim()) ||
    path.join(os.homedir(), ".config")
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recursively replace {env:VAR} placeholders with the resolved value. Used to bake
// gateway provider secrets (e.g. the LLM-gateway virtual key) into opencode.json
// SERVER-SIDE, where the value is reliably present. OpenCode's own {env:...}
// resolution happens inside the (possibly sandboxed) run process, whose env
// plumbing is not guaranteed to carry the key to OpenCode's spawned server -- so
// we resolve it here. Unresolvable placeholders are left intact for OpenCode to try.
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

function parseProviderConfig(
  raw: unknown,
  resolveEnv: (name: string) => string | undefined,
  notes: string[],
): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.trim().length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Surface the misconfiguration instead of silently dropping the provider
    // block; an unparseable value would otherwise be undiagnosable.
    notes.push("PAPERCLIP_OPENCODE_PROVIDERS contains invalid JSON; custom providers ignored.");
    return null;
  }
  if (!isPlainObject(parsed)) {
    notes.push(
      "PAPERCLIP_OPENCODE_PROVIDERS is set but is not a JSON object; custom providers ignored.",
    );
    return null;
  }
  // Only keep provider entries that are themselves objects; surface the ones
  // we drop so a malformed entry is just as diagnosable as malformed JSON.
  const providers: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (isPlainObject(value)) providers[key] = expandEnvPlaceholders(value, resolveEnv);
    else skipped.push(key);
  }
  if (skipped.length > 0) {
    notes.push(
      `PAPERCLIP_OPENCODE_PROVIDERS: skipped provider(s) with non-object values: ${skipped.join(", ")}.`,
    );
  }
  return Object.keys(providers).length > 0 ? providers : null;
}

function parseConfiguredModelRef(raw: unknown): { provider: string; model: string } | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    const parsed = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  targetIsRemote?: boolean;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  if (!skipPermissions) {
    return {
      env: input.env,
      notes: [],
      runtimeDiagnostics: {},
      cleanup: async () => {},
    };
  }

  // For remote execution targets the host XDG_CONFIG_HOME path is meaningless
  // (and actively harmful — it leaks a macOS-only path into the remote Linux
  // env). Callers that need to ship a runtime opencode config to the remote
  // box do that via prepareAdapterExecutionTargetRuntime in execute.ts; this
  // host-fs helper is local-only.
  if (input.targetIsRemote) {
    return {
      env: input.env,
      notes: [],
      runtimeDiagnostics: {},
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const runtimeConfigHome = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-config-"));
  const runtimeConfigDir = path.join(runtimeConfigHome, "opencode");
  const runtimeConfigPath = path.join(runtimeConfigDir, "opencode.json");

  await fs.mkdir(runtimeConfigDir, { recursive: true });
  try {
    await fs.cp(sourceConfigDir, runtimeConfigDir, {
      recursive: true,
      force: true,
      errorOnExist: false,
      dereference: false,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") {
      throw err;
    }
  }

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};
  const notes = [
    "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
  ];

  // Merge gateway/custom provider definitions supplied via PAPERCLIP_OPENCODE_PROVIDERS
  // (a JSON object in OpenCode's `provider` shape). OpenCode resolves a `--model
  // provider/model` only when that model exists in a provider's `models` map, and
  // OPENCODE_ALLOW_ALL_MODELS does NOT bypass its internal getModel(). So routing a
  // gateway model (e.g. an EU LLM gateway exposing OpenAI-compatible /v1) requires a
  // custom provider with an explicit models map. We accept it as config (not
  // hard-coded) so the gateway URL, key env, and model list stay declarative.
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS,
    resolveEnv,
    notes,
  );
  const existingProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
  let nextProvider = gatewayProviders
    ? { ...existingProvider, ...gatewayProviders }
    : existingProvider;
  if (gatewayProviders) {
    notes.push(
      `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
    );
  }

  // Register the configured model on its provider's models map. OpenCode resolves
  // `--model provider/model` only when the model id exists in that map, so ids the
  // models.dev catalog does not carry — OpenRouter routing variants such as
  // `openai/gpt-oss-120b:nitro`, or models newer than the bundled catalog — are
  // otherwise rejected with "Model not found" even though the provider serves them.
  // An empty entry deep-merges with catalog metadata, so this is a no-op for models
  // the catalog already knows, and we never clobber an explicit definition from the
  // user config or PAPERCLIP_OPENCODE_PROVIDERS.
  const configuredModel = parseConfiguredModelRef(input.config.model);
  if (configuredModel) {
    const providerEntry = isPlainObject(nextProvider[configuredModel.provider])
      ? { ...(nextProvider[configuredModel.provider] as Record<string, unknown>) }
      : {};
    const providerModels = isPlainObject(providerEntry.models)
      ? { ...(providerEntry.models as Record<string, unknown>) }
      : {};
    if (!isPlainObject(providerModels[configuredModel.model])) {
      providerModels[configuredModel.model] = {};
      providerEntry.models = providerModels;
      nextProvider = { ...nextProvider, [configuredModel.provider]: providerEntry };
      notes.push(
        `Registered configured model ${configuredModel.provider}/${configuredModel.model} in the runtime OpenCode config.`,
      );
    }
  }

  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
  };
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }

  // Measure and optionally constrain the per-run MCP tool surface. Without an
  // explicit allow/deny configuration every configured server stays enabled
  // (unchanged behavior); the measurement note is always emitted so runs carry
  // BEFORE/AFTER tool-surface metrics for cost review. A scoped Engineer
  // Paperclip Ops run uses the filter to keep unrelated Cloudflare/Playwright/
  // Shadcn/Storybook connections out of the generated runtime surface.
  const toolSurfaceFilter = resolveOpenCodeMcpToolSurfaceFilter({ config: input.config, env: input.env });
  const toolSurfaceResult = applyOpenCodeMcpToolSurface(existingConfig.mcp, toolSurfaceFilter);
  if (toolSurfaceResult.beforeCount > 0 || toolSurfaceFilter.active) {
    notes.push(
      `MCP tool surface: ${toolSurfaceResult.beforeCount} server(s) configured -> ${toolSurfaceResult.afterCount} enabled` +
        `${toolSurfaceResult.removedByAllowlist.length ? `; allowlist removed: ${toolSurfaceResult.removedByAllowlist.join(", ")}` : ""}` +
        `${toolSurfaceResult.removedByDenylist.length ? `; denylist removed: ${toolSurfaceResult.removedByDenylist.join(", ")}` : ""}` +
        `${toolSurfaceResult.removedAsAliases.length ? `; duplicate aliases collapsed: ${toolSurfaceResult.removedAsAliases.join(", ")}` : ""}` +
        `.`,
    );
    if (toolSurfaceResult.next !== null) {
      nextConfig.mcp = toolSurfaceResult.next;
    }
  }

  // PROVIDER SCHEMA PREFLIGHT (P0): validate every generated tool/function name
  // against the provider length limit BEFORE the model is inferred. The upstream
  // OpenAI-compatible/Console Go path rejects tool names >64 chars; we fail fast
  // with a specific PROVIDER_SCHEMA_CONTRACT error naming the offending
  // connection/tool instead of letting the provider reject mid-inference.
  // Canonical tool identity is preserved — we never silently rename.
  const finalMcp = toolSurfaceResult.next ?? (isPlainObject(existingConfig.mcp) ? existingConfig.mcp : null);
  validateProviderSchemaContract({ providers: nextProvider, mcp: finalMcp });

  // Pin OpenCode's auxiliary "small" model (used for session-title generation and
  // other helper tasks) via PAPERCLIP_OPENCODE_SMALL_MODEL. OpenCode otherwise
  // defaults the small model to a built-in provider default (e.g. a claude-* model
  // for the anthropic provider); when that provider is repointed at a gateway that
  // does not serve that exact model, the title-gen call fails and aborts the run.
  // Setting small_model to a gateway-served model keeps every call on supported models.
  const smallModel = (input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL)?.trim();
  if (smallModel) {
    nextConfig.small_model = smallModel;
    notes.push(`Pinned OpenCode small_model to ${smallModel}.`);
  }
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    runtimeDiagnostics: openCodeRuntimeDiagnosticsFromToolSurface(toolSurfaceResult),
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}
