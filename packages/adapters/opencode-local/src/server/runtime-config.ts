import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

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

// OpenCode waits `options.headerTimeout` ms for a gateway's response headers and
// defaults that to 300_000. A reverse proxy in front of a gateway (Cloudflare 522,
// most ELBs) answers an origin stall by HOLDING the socket open rather than
// refusing it, so the client sees a hang instead of an error -- and the socket
// stays doomed even after the proxy recovers. A 2-minute edge flap therefore burns
// the full 300 s on every in-flight request, and because retry backoff is far
// shorter than 300 s the first retry is spent on another doomed socket instead of
// on the recovered edge. Bounding time-to-first-byte converts that hang into a
// prompt, retryable failure so the retry lands after a typical flap has cleared.
//
// Only applied to gateway providers injected from PAPERCLIP_OPENCODE_PROVIDERS --
// the class that dials a remote gateway through a proxy we do not control. An
// explicit headerTimeout in the provider block always wins, including `false`
// (meaning "no TTFB bound"), so this is a default and never an override.
const DEFAULT_GATEWAY_HEADER_TIMEOUT_MS = 120_000;

function resolveGatewayHeaderTimeout(raw: string | undefined): number | false | null {
  if (raw === undefined) return DEFAULT_GATEWAY_HEADER_TIMEOUT_MS;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return DEFAULT_GATEWAY_HEADER_TIMEOUT_MS;
  // Opt out entirely and leave OpenCode's own default in place.
  if (/^(false|off|0|none)$/i.test(trimmed)) return false;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function applyGatewayHeaderTimeout(
  providers: Record<string, unknown>,
  rawOverride: string | undefined,
  notes: string[],
): Record<string, unknown> {
  const resolved = resolveGatewayHeaderTimeout(rawOverride);
  if (resolved === null) {
    notes.push(
      "PAPERCLIP_OPENCODE_PROVIDER_HEADER_TIMEOUT_MS is not a positive number; leaving OpenCode's default header timeout in place.",
    );
    return providers;
  }
  if (resolved === false) return providers;

  const out: Record<string, unknown> = {};
  const applied: string[] = [];
  for (const [name, provider] of Object.entries(providers)) {
    if (!isPlainObject(provider)) {
      out[name] = provider;
      continue;
    }
    const options = isPlainObject(provider.options) ? provider.options : {};
    // Respect an explicit value of any kind, including `false`.
    if ("headerTimeout" in options) {
      out[name] = provider;
      continue;
    }
    out[name] = { ...provider, options: { ...options, headerTimeout: resolved } };
    applied.push(name);
  }
  if (applied.length > 0) {
    notes.push(
      `Bounded OpenCode provider header timeout to ${resolved}ms for: ${applied.join(", ")}.`,
    );
  }
  return out;
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
  const notes = [
    "Injected runtime OpenCode config with permission=allow for all tools and connections.",
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
  const boundedGatewayProviders = gatewayProviders
    ? applyGatewayHeaderTimeout(
        gatewayProviders,
        input.env.PAPERCLIP_OPENCODE_PROVIDER_HEADER_TIMEOUT_MS ??
          process.env.PAPERCLIP_OPENCODE_PROVIDER_HEADER_TIMEOUT_MS,
        notes,
      )
    : null;
  let nextProvider = boundedGatewayProviders
    ? { ...existingProvider, ...boundedGatewayProviders }
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
    permission: "allow",
  };
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
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
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes,
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}

/** Managed credentials must never leave host-only homes in a remote process. */
export function prepareManagedOpenCodeRemoteHomes(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
  runtimeRootDir: string | null | undefined;
  runId: string;
  configDir?: string;
}): void {
  if (!input.config.managedAiConnection) return;
  if (!input.runtimeRootDir) throw new Error("Managed OpenCode authentication requires an isolated remote runtime directory.");
  const home = path.posix.join(input.runtimeRootDir, "managed-auth", input.runId);
  Object.assign(input.env, {
    HOME: home,
    XDG_CONFIG_HOME: input.configDir ?? path.posix.join(home, "config"),
    XDG_DATA_HOME: path.posix.join(home, "data"),
    XDG_CACHE_HOME: path.posix.join(home, "cache"),
    XDG_STATE_HOME: path.posix.join(home, "state"),
  });
}
