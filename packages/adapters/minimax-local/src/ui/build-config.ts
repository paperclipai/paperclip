import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import {
  DEFAULT_MINIMAX_LOCAL_BASE_URL,
  DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS,
  DEFAULT_MINIMAX_LOCAL_MODEL,
  DEFAULT_MINIMAX_LOCAL_STRIP_THINK,
  DEFAULT_MINIMAX_LOCAL_TEMPERATURE,
} from "../index.js";

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

function readSchemaNumber(
  values: CreateConfigValues,
  key: string,
  fallback: number,
): number {
  const raw = values.adapterSchemaValues?.[key];
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function readSchemaString(
  values: CreateConfigValues,
  key: string,
  fallback: string,
): string {
  const raw = values.adapterSchemaValues?.[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : fallback;
}

function readSchemaBoolean(
  values: CreateConfigValues,
  key: string,
  fallback: boolean,
): boolean {
  const raw = values.adapterSchemaValues?.[key];
  return typeof raw === "boolean" ? raw : fallback;
}

export function buildMiniMaxLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const model = (v.model || DEFAULT_MINIMAX_LOCAL_MODEL).trim();
  const env = parseEnvBindings(v.envBindings);

  return {
    model,
    primaryModel: readSchemaString(v, "primaryModel", model),
    baseUrl: readSchemaString(v, "baseUrl", DEFAULT_MINIMAX_LOCAL_BASE_URL),
    temperature: readSchemaNumber(v, "temperature", DEFAULT_MINIMAX_LOCAL_TEMPERATURE),
    max_completion_tokens: Math.max(
      1,
      Math.trunc(readSchemaNumber(v, "max_completion_tokens", DEFAULT_MINIMAX_LOCAL_MAX_COMPLETION_TOKENS)),
    ),
    stripThink: readSchemaBoolean(v, "stripThink", DEFAULT_MINIMAX_LOCAL_STRIP_THINK),
    ...(v.cwd ? { cwd: v.cwd, workingDirectory: v.cwd } : {}),
    ...(v.instructionsFilePath ? { instructionsFilePath: v.instructionsFilePath } : {}),
    ...(v.promptTemplate ? { promptTemplate: v.promptTemplate } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
}
