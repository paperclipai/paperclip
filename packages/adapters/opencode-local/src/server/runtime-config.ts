import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

export interface OpenCodeRuntimeMcpConfigEntry {
  name: string;
  connectionId: string;
  url: string;
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

function buildRuntimeMcpConfig(
  servers: OpenCodeRuntimeMcpConfigEntry[],
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  const usedNames = new Set<string>();
  for (const [index, server] of servers.entries()) {
    const label = server.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "_")
      .replace(/^_+|_+$/g, "") || `server_${index + 1}`;
    const identity = server.connectionId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8).toLowerCase();
    const baseName = `paperclip_${label}${identity ? `_${identity}` : ""}`;
    let name = baseName;
    let suffix = 2;
    while (usedNames.has(name)) name = `${baseName}_${suffix++}`;
    usedNames.add(name);
    config[name] = {
      type: "remote",
      url: server.url,
      enabled: true,
      oauth: false,
    };
  }
  return config;
}

function parseJsoncObject(raw: string, source: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !isPlainObject(parsed)) {
    throw new Error(`Cannot safely inspect OpenCode config at ${source}.`);
  }
  return parsed;
}

async function readJsonObject(filepath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    return parseJsoncObject(raw, filepath);
  } catch {
    return {};
  }
}

function collectMcpNames(config: Record<string, unknown>, names: Set<string>): void {
  if (!isPlainObject(config.mcp)) return;
  for (const name of Object.keys(config.mcp)) names.add(name);
}

async function collectMcpNamesFromFile(filepath: string, names: Set<string>): Promise<void> {
  try {
    const raw = await fs.readFile(filepath, "utf8");
    collectMcpNames(parseJsoncObject(raw, filepath), names);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
}

async function materializeCopiedConfigFile(filepath: string): Promise<void> {
  try {
    const stat = await fs.lstat(filepath);
    if (!stat.isSymbolicLink()) return;
    const raw = await fs.readFile(filepath);
    await fs.rm(filepath, { force: true });
    await fs.writeFile(filepath, raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
  }
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  cwd?: string;
  targetIsRemote?: boolean;
  runtimeMcpServers?: OpenCodeRuntimeMcpConfigEntry[];
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  const hasRuntimeMcpOverride = input.runtimeMcpServers !== undefined;
  const runtimeMcpServers = input.runtimeMcpServers ?? [];
  if (!skipPermissions && !hasRuntimeMcpOverride) {
    return {
      env: input.env,
      notes: [],
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
      cleanup: async () => {},
    };
  }

  const sourceConfigDir = path.join(resolveXdgConfigHome(input.env), "opencode");
  const inheritedMcpNames = new Set<string>();
  let inlineConfig: Record<string, unknown> = {};
  if (hasRuntimeMcpOverride) {
    const configuredHome = input.env.HOME?.trim() || process.env.HOME?.trim() || os.homedir();
    const configuredFile = input.env.OPENCODE_CONFIG ?? process.env.OPENCODE_CONFIG;
    const configuredDir = input.env.OPENCODE_CONFIG_DIR ?? process.env.OPENCODE_CONFIG_DIR;
    const configPathBase = input.cwd ?? process.cwd();
    const configFiles = new Set([
      path.join(sourceConfigDir, "config.json"),
      path.join(sourceConfigDir, "opencode.json"),
      path.join(sourceConfigDir, "opencode.jsonc"),
      path.join(configuredHome, ".opencode", "opencode.json"),
      path.join(configuredHome, ".opencode", "opencode.jsonc"),
      ...(configuredFile?.trim() ? [path.resolve(configPathBase, configuredFile)] : []),
      ...(configuredDir?.trim()
        ? [
            path.resolve(configPathBase, configuredDir, "opencode.json"),
            path.resolve(configPathBase, configuredDir, "opencode.jsonc"),
          ]
        : []),
    ]);
    await Promise.all(
      [...configFiles].map((filepath) => collectMcpNamesFromFile(filepath, inheritedMcpNames)),
    );
    const inlineRaw = input.env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
    if (inlineRaw?.trim()) {
      inlineConfig = parseJsoncObject(inlineRaw, "OPENCODE_CONFIG_CONTENT");
      collectMcpNames(inlineConfig, inheritedMcpNames);
    }
  }
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
  if (hasRuntimeMcpOverride) {
    await fs.rm(path.join(runtimeConfigDir, "config"), { force: true });
  }
  await materializeCopiedConfigFile(runtimeConfigPath);

  const existingConfig = await readJsonObject(runtimeConfigPath);
  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};
  const notes = skipPermissions
    ? ["Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts."]
    : [];

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
  };
  if (skipPermissions) {
    nextConfig.permission = {
      ...existingPermission,
      external_directory: "allow",
    };
  }
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }
  if (hasRuntimeMcpOverride) {
    const managedMcp = buildRuntimeMcpConfig(runtimeMcpServers);
    nextConfig.mcp = managedMcp;
    inlineConfig = {
      ...inlineConfig,
      mcp: {
        ...Object.fromEntries(
          [...inheritedMcpNames].map((name) => [name, { enabled: false }]),
        ),
        ...managedMcp,
      },
    };
    if (runtimeMcpServers.length > 0) {
      notes.push(`Injected ${runtimeMcpServers.length} Paperclip runtime MCP relay(s).`);
    }
  }

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
  const serializedConfig = JSON.stringify(nextConfig, null, 2);
  await fs.writeFile(runtimeConfigPath, `${serializedConfig}\n`, "utf8");

  const runtimeEnv: Record<string, string> = {
    ...input.env,
    XDG_CONFIG_HOME: runtimeConfigHome,
  };
  if (hasRuntimeMcpOverride) {
    runtimeEnv.OPENCODE_CONFIG_CONTENT = JSON.stringify(inlineConfig);
  }

  return {
    env: runtimeEnv,
    notes,
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}
