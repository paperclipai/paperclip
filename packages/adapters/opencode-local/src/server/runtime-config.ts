import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asBoolean } from "@paperclipai/adapter-utils/server-utils";
import { collectOllamaModelNames, resolveOllamaBaseUrl } from "./local-provider.js";

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

function mergeOllamaProviderConfig(input: {
  config: Record<string, unknown>;
  env: Record<string, string>;
  runtimeConfig: Record<string, unknown>;
}): { nextConfig: Record<string, unknown>; notes: string[] } {
  const baseUrl = resolveOllamaBaseUrl(input.config, input.env);
  const modelNames = collectOllamaModelNames([
    typeof input.config.model === "string" ? input.config.model : null,
    typeof input.config.fallbackModel === "string" ? input.config.fallbackModel : null,
  ]);
  if (!baseUrl || modelNames.length === 0) {
    return { nextConfig: input.runtimeConfig, notes: [] };
  }

  const provider = isPlainObject(input.runtimeConfig.provider) ? input.runtimeConfig.provider : {};
  const existingOllama = isPlainObject(provider.ollama) ? provider.ollama : {};
  const existingOptions = isPlainObject(existingOllama.options) ? existingOllama.options : {};
  const existingModels = isPlainObject(existingOllama.models) ? existingOllama.models : {};

  const mergedModels: Record<string, unknown> = { ...existingModels };
  for (const modelName of modelNames) {
    if (!isPlainObject(mergedModels[modelName])) {
      mergedModels[modelName] = {};
    }
  }

  return {
    nextConfig: {
      ...input.runtimeConfig,
      provider: {
        ...provider,
        ollama: {
          ...existingOllama,
          npm: "@ai-sdk/openai-compatible",
          name: "Ollama",
          options: {
            ...existingOptions,
            baseURL: baseUrl,
          },
          models: mergedModels,
        },
      },
    },
    notes: [
      `Injected OpenCode Ollama provider config for ${modelNames.join(", ")} via ${baseUrl}.`,
    ],
  };
}

export async function prepareOpenCodeRuntimeConfig(input: {
  env: Record<string, string>;
  config: Record<string, unknown>;
}): Promise<PreparedOpenCodeRuntimeConfig> {
  const skipPermissions = asBoolean(input.config.dangerouslySkipPermissions, true);
  if (!skipPermissions) {
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
  const permissionConfig = {
    ...existingConfig,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
  };
  const { nextConfig, notes } = mergeOllamaProviderConfig({
    config: input.config,
    env: input.env,
    runtimeConfig: permissionConfig,
  });
  await fs.writeFile(runtimeConfigPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");

  return {
    env: {
      ...input.env,
      XDG_CONFIG_HOME: runtimeConfigHome,
    },
    notes: [
      "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
      ...notes,
    ],
    cleanup: async () => {
      await fs.rm(runtimeConfigHome, { recursive: true, force: true });
    },
  };
}
