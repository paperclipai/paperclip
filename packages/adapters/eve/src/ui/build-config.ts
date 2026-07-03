import type { CreateConfigValues } from "@paperclipai/adapter-utils";

function parseJsonObjectString(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    if (typeof value === "string" && value.trim().length > 0) {
      try {
        const parsed = JSON.parse(value) as unknown;
        if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
    return null;
  }
  return value as Record<string, unknown>;
}

function parseEnvVars(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function parseEnvBindings(bindings: unknown): Record<string, unknown> {
  if (typeof bindings !== "object" || bindings === null || Array.isArray(bindings)) return {};
  const env: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(bindings)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (typeof raw === "string") {
      env[key] = { type: "plain", value: raw };
      continue;
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const rec = raw as Record<string, unknown>;
    if (rec.type === "plain" && typeof rec.value === "string") {
      env[key] = { type: "plain", value: rec.value };
      continue;
    }
    if (rec.type === "secret_ref" && typeof rec.secretId === "string") {
      env[key] = {
        type: "secret_ref",
        secretId: rec.secretId,
        ...(typeof rec.version === "number" || rec.version === "latest"
          ? { version: rec.version }
          : {}),
      };
    }
  }
  return env;
}

function buildSharedConfig(values: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {
    ...(values.adapterSchemaValues ?? {}),
  };
  if (values.instructionsFilePath) config.instructionsFilePath = values.instructionsFilePath;
  if (values.promptTemplate) config.promptTemplate = values.promptTemplate;
  if (values.bootstrapPrompt) config.bootstrapPromptTemplate = values.bootstrapPrompt;
  if (values.model?.trim()) config.model = values.model.trim();
  return config;
}

export function buildEveGatewayConfig(values: CreateConfigValues): Record<string, unknown> {
  const config = buildSharedConfig(values);

  // The schema textarea stores headers as a JSON string; the server expects an
  // object. Parse it here (also accept values.headersJson from custom forms).
  const headers =
    parseJsonObjectString(config.headers) ?? parseJsonObjectString(values.headersJson);
  if (headers && Object.keys(headers).length > 0) {
    config.headers = headers;
  } else {
    delete config.headers;
  }

  return config;
}

export function buildEveLocalConfig(values: CreateConfigValues): Record<string, unknown> {
  const config = buildSharedConfig(values);
  if (values.cwd && !config.projectDir) config.projectDir = values.cwd;

  const env = parseJsonObjectString(config.env) ?? {};
  const bindings = parseEnvBindings(values.envBindings);
  for (const [key, value] of Object.entries(bindings)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) env[key] = value;
  }
  const legacy = parseEnvVars(values.envVars ?? "");
  for (const [key, value] of Object.entries(legacy)) {
    if (!Object.prototype.hasOwnProperty.call(env, key)) {
      env[key] = { type: "plain", value };
    }
  }
  if (Object.keys(env).length > 0) {
    config.env = env;
  } else {
    delete config.env;
  }

  return config;
}
