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
  const notes = [
    "Injected runtime OpenCode config with permission.external_directory=allow to avoid headless approval prompts.",
  ];
  const nextConfig: Record<string, unknown> = {
    ...existingConfig,
    permission: {
      ...existingPermission,
      external_directory: "allow",
    },
  };

  // Inject per-model responseFormat: json_object when jsonMode is enabled. This
  // constrains the model's output to valid JSON on every request, preventing
  // <think> tags and free-text preambles from leaking into structured-output
  // agents (Local-AI Catalog Enricher, Doc Extractor, SKU Cataloger).
  const jsonMode = input.config.jsonMode === true;
  const configModel = typeof input.config.model === "string" ? input.config.model.trim() : "";
  const slashIdx = configModel.indexOf("/");
  if (jsonMode && slashIdx > 0 && slashIdx < configModel.length - 1) {
    const providerId = configModel.slice(0, slashIdx);
    const modelId = configModel.slice(slashIdx + 1);
    const baseProvider = isPlainObject(existingConfig.provider) ? existingConfig.provider : {};
    const baseProviderEntry = isPlainObject(baseProvider[providerId]) ? baseProvider[providerId] : {};
    const baseModels = isPlainObject(baseProviderEntry.models) ? baseProviderEntry.models : {};
    const baseModelEntry = isPlainObject(baseModels[modelId]) ? baseModels[modelId] : {};
    nextConfig.provider = {
      ...baseProvider,
      [providerId]: {
        ...baseProviderEntry,
        models: {
          ...baseModels,
          [modelId]: {
            ...baseModelEntry,
            options: {
              ...(isPlainObject(baseModelEntry.options) ? baseModelEntry.options : {}),
              responseFormat: { type: "json_object" },
            },
          },
        },
      },
    };
    notes.push(`Injected responseFormat:json_object for model ${configModel} via jsonMode.`);
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
