import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";

type PreparedOpenCodeRuntimeConfig = {
  env: Record<string, string>;
  notes: string[];
  cleanup: () => Promise<void>;
};

/**
 * Read the Ollama provider's baseURL from the user's opencode config, if
 * present.  Returns null when the config file is missing or does not contain a
 * valid string value at provider.ollama.options.baseURL.
 */
export async function readExistingOpencodeOllamaBaseUrl(
  env: Record<string, string>,
): Promise<string | null> {
  const xdgConfigHome = resolveXdgConfigHome(env);
  const configPath = path.join(xdgConfigHome, "opencode", "opencode.json");
  const config = await readJsonObject(configPath);
  if (!isPlainObject(config.provider)) return null;
  const provider = config.provider as Record<string, unknown>;
  if (!isPlainObject(provider.ollama)) return null;
  const ollama = provider.ollama as Record<string, unknown>;
  if (!isPlainObject(ollama.options)) return null;
  const options = ollama.options as Record<string, unknown>;
  return typeof options.baseURL === "string" && options.baseURL.trim()
    ? options.baseURL.trim()
    : null;
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
  /**
   * When set, overrides provider.ollama.options.baseURL in the opencode
   * runtime config so that opencode routes Ollama calls through the
   * normalization proxy instead of the real Ollama endpoint.
   */
  ollamaProxyBaseUrl?: string;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  const needsProxyInjection = typeof input.ollamaProxyBaseUrl === "string" && input.ollamaProxyBaseUrl.trim().length > 0;
  if (!skipPermissions && !needsProxyInjection) {
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
  const existingPermission = isPlainObject(existingConfig.permission)
    ? existingConfig.permission
    : {};
  const nextConfig: Record<string, unknown> = { ...existingConfig };

  if (skipPermissions) {
    nextConfig.permission = {
      ...(existingPermission as Record<string, unknown>),
      external_directory: "allow",
    };
  }

  // Redirect Ollama API calls through the normalization proxy when requested.
  if (needsProxyInjection && isPlainObject(existingConfig.provider)) {
    const existingProvider = existingConfig.provider as Record<string, unknown>;
    const existingOllama = isPlainObject(existingProvider.ollama)
      ? (existingProvider.ollama as Record<string, unknown>)
      : {};
    const existingOptions = isPlainObject(existingOllama.options)
      ? (existingOllama.options as Record<string, unknown>)
      : {};
    nextConfig.provider = {
      ...existingProvider,
      ollama: {
        ...existingOllama,
        options: {
          ...existingOptions,
          baseURL: input.ollamaProxyBaseUrl,
        },
      },
    };
  }

  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  const notes: string[] = [];
  if (skipPermissions) {
    notes.push(
      "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
    );
  }
  if (needsProxyInjection) {
    notes.push(
      `Redirected Ollama provider through bash-tool normalization proxy at ${input.ollamaProxyBaseUrl}.`,
    );
  }

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
