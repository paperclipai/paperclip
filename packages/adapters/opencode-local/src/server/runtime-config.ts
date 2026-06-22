import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean, asString } from "@paperclipai/adapter-utils/server-utils";

const CLOUDFLARE_MODEL_PREFIX = "cloudflare/";
const WORKERS_AI_PROVIDER_KEY = "cloudflare";

type WorkersAiProviderBlock = {
  npm: string;
  name: string;
  options: { baseURL: string; apiKey: string };
  models: Record<string, { name: string }>;
};

/**
 * Build the OpenCode `provider.cloudflare` block for a Workers AI request, or
 * return null when this run does not target Workers AI (model not prefixed
 * `cloudflare/`) or required inputs are missing (empty baseURL or apiKey).
 *
 * The token is read from the already secret-resolved `env` (Paperclip
 * materializes the agent profile's `env` secret_refs into plaintext before
 * prepareOpenCodeRuntimeConfig runs), so no secret handling happens here.
 */
function buildWorkersAiProvider(
  config: Record<string, unknown>,
  env: Record<string, string>,
): WorkersAiProviderBlock | null {
  const model = asString(config.model, "");
  if (!model.startsWith(CLOUDFLARE_MODEL_PREFIX)) return null;
  const cfModel = model.slice(CLOUDFLARE_MODEL_PREFIX.length);
  if (!cfModel) return null;

  const baseURL = asString(config.workersAiBaseUrl, "");
  const tokenKey = asString(config.workersAiTokenEnv, "CLOUDFLARE_WORKERS_AI_TOKEN");
  const apiKey = env[tokenKey] ?? "";
  if (!baseURL || !apiKey) return null;

  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Cloudflare Workers AI",
    options: { baseURL, apiKey },
    models: { [cfModel]: { name: cfModel } },
  };
}

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
  const workersAiProvider = buildWorkersAiProvider(input.config, input.env);
  const gatewayProvidersRaw =
    input.env.PAPERCLIP_OPENCODE_PROVIDERS ?? process.env.PAPERCLIP_OPENCODE_PROVIDERS;
  const smallModel = (
    input.env.PAPERCLIP_OPENCODE_SMALL_MODEL ?? process.env.PAPERCLIP_OPENCODE_SMALL_MODEL
  )?.trim();

  // We only need to write a runtime opencode.json when there is something to
  // inject: the permission block (skipPermissions), a Workers AI provider block,
  // gateway providers (PAPERCLIP_OPENCODE_PROVIDERS), or a pinned small model.
  // Otherwise preserve the original no-op behavior exactly.
  if (!skipPermissions && !workersAiProvider && !gatewayProvidersRaw && !smallModel) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  // host-fs helper: for remote targets the host XDG_CONFIG_HOME path is meaningless
  // (and leaks a host-only path into the remote env). Upstream routes remote runtime
  // config via prepareAdapterExecutionTargetRuntime in execute.ts.
  // NOTE: remote Workers AI routing must be re-verified against that remote path —
  // this branch previously shipped the Workers AI block to remote via this helper's
  // xdgConfig asset; upstream later made this helper local-only. See PR #8384.
  if (input.targetIsRemote) {
    return {
      env: input.env,
      notes: [],
      cleanup: async () => {},
    };
  }

  // This helper writes a temp opencode.json under a fresh XDG_CONFIG_HOME and
  // returns that path. For remote execution targets, execute.ts stages this
  // temp dir as the `xdgConfig` runtime asset, syncs it to the remote box, and
  // repoints XDG_CONFIG_HOME at the remote synced path — so the permission and
  // Workers AI provider blocks injected below ship to remote as well as local.
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
  const notes: string[] = [];

  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};

  // Merge gateway/custom provider definitions supplied via PAPERCLIP_OPENCODE_PROVIDERS
  // (a JSON object in OpenCode's `provider` shape). OpenCode resolves a `--model
  // provider/model` only when that model exists in a provider's `models` map, and
  // OPENCODE_ALLOW_ALL_MODELS does NOT bypass its internal getModel(). So routing a
  // gateway model (e.g. an EU LLM gateway exposing OpenAI-compatible /v1) requires a
  // custom provider with an explicit models map. We accept it as config (not
  // hard-coded) so the gateway URL, key env, and model list stay declarative.
  const resolveEnv = (name: string): string | undefined => input.env[name] ?? process.env[name];
  const gatewayProviders = parseProviderConfig(gatewayProvidersRaw, resolveEnv, notes);
  const existingProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
  const nextProvider: Record<string, unknown> = { ...existingProvider };
  if (gatewayProviders) {
    Object.assign(nextProvider, gatewayProviders);
    notes.push(
      `Injected ${Object.keys(gatewayProviders).length} custom OpenCode provider(s) from PAPERCLIP_OPENCODE_PROVIDERS: ${Object.keys(gatewayProviders).join(", ")}.`,
    );
  }
  if (workersAiProvider) {
    nextProvider[WORKERS_AI_PROVIDER_KEY] = workersAiProvider;
    notes.push(
      "Injected runtime OpenCode provider.cloudflare block to route the Workers AI model through @ai-sdk/openai-compatible.",
    );
  }

  const nextConfig: Record<string, unknown> = { ...existingConfig };
  if (skipPermissions) {
    nextConfig.permission = {
      ...existingPermission,
      external_directory: "allow",
    };
    notes.push(
      "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
    );
  }
  if (Object.keys(nextProvider).length > 0) {
    nextConfig.provider = nextProvider;
  }

  // Pin OpenCode's auxiliary "small" model (used for session-title generation and
  // other helper tasks) via PAPERCLIP_OPENCODE_SMALL_MODEL. OpenCode otherwise
  // defaults the small model to a built-in provider default (e.g. a claude-* model
  // for the anthropic provider); when that provider is repointed at a gateway that
  // does not serve that exact model, the title-gen call fails and aborts the run.
  // Setting small_model to a gateway-served model keeps every call on supported models.
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
