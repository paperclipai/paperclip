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

  // We only need to write a runtime opencode.json when there is something to
  // inject: either the permission block (skipPermissions) or a Workers AI
  // provider block. Otherwise preserve the original no-op behavior exactly.
  if (!skipPermissions && !workersAiProvider) {
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
  //
  // NOTE: Workers AI provider injection for remote execution targets is a
  // follow-up. The provider block built above is intentionally NOT shipped to
  // remote here; remote runtime config is produced by a separate path.
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
  const nextConfig: Record<string, unknown> = { ...existingConfig };
  const notes: string[] = [];

  if (skipPermissions) {
    const existingPermission = isPlainObject(existingConfig.permission)
      ? existingConfig.permission
      : {};
    nextConfig.permission = {
      ...existingPermission,
      external_directory: "allow",
    };
    notes.push(
      "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
    );
  }

  if (workersAiProvider) {
    const existingProvider = isPlainObject(existingConfig.provider)
      ? existingConfig.provider
      : {};
    nextConfig.provider = {
      ...existingProvider,
      [WORKERS_AI_PROVIDER_KEY]: workersAiProvider,
    };
    notes.push(
      "Injected runtime OpenCode provider.cloudflare block to route the Workers AI model through @ai-sdk/openai-compatible.",
    );
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
