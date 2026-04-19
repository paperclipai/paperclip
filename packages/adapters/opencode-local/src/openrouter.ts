function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readConfiguredPlainBindingString(value: unknown): string | null {
  if (readNonEmptyString(value)) return readNonEmptyString(value);
  if (!isPlainObject(value)) return null;
  if (value.type !== "plain") return null;
  return readNonEmptyString(value.value);
}

function hasConfiguredBinding(value: unknown): boolean {
  if (readNonEmptyString(value)) return true;
  if (!isPlainObject(value)) return false;
  if (value.type === "plain") return readNonEmptyString(value.value) !== null;
  if (value.type === "secret_ref") return readNonEmptyString(value.secretId) !== null;
  return false;
}

const OPENAI_COMPATIBLE_BASE_URL_KEYS = [
  "OPENAI_BASE_URL",
  "OPENAI_API_BASE",
  "OPENAI_API_BASE_URL",
] as const;

export const OPENCODE_PROVIDER_MODELS_HINT =
  "Configure the provider in OpenCode, run `opencode models`, and then select an available provider/model ID.";

export const OPENCODE_NATIVE_OPENROUTER_HINT =
  "Use OpenCode's native OpenRouter provider/auth flow, run `opencode models`, and select an `openrouter/...` model. Do not route OpenRouter through `OPENAI_BASE_URL` in this adapter.";

export type OpenCodeOpenRouterEnvInspection = {
  hasOpenRouterApiKey: boolean;
  openAiCompatibleBaseUrlKey: (typeof OPENAI_COMPATIBLE_BASE_URL_KEYS)[number] | null;
  openAiCompatibleBaseUrlValue: string | null;
  usesOpenAiCompatibleOpenRouterBaseUrl: boolean;
};

export type OpenCodeOpenRouterMisconfiguration = OpenCodeOpenRouterEnvInspection & {
  code: "opencode_openrouter_openai_compat_unsupported";
  message: string;
  detail: string | null;
  hint: string;
};

export function inspectOpenCodeOpenRouterEnv(env: unknown): OpenCodeOpenRouterEnvInspection {
  const record = isPlainObject(env) ? env : {};
  const hasOpenRouterApiKey = hasConfiguredBinding(record.OPENROUTER_API_KEY);

  for (const key of OPENAI_COMPATIBLE_BASE_URL_KEYS) {
    const raw = readConfiguredPlainBindingString(record[key]);
    if (!raw) continue;
    if (!/openrouter\.ai/i.test(raw)) continue;
    return {
      hasOpenRouterApiKey,
      openAiCompatibleBaseUrlKey: key,
      openAiCompatibleBaseUrlValue: raw,
      usesOpenAiCompatibleOpenRouterBaseUrl: true,
    };
  }

  return {
    hasOpenRouterApiKey,
    openAiCompatibleBaseUrlKey: null,
    openAiCompatibleBaseUrlValue: null,
    usesOpenAiCompatibleOpenRouterBaseUrl: false,
  };
}

export function detectOpenCodeOpenRouterMisconfiguration(
  env: unknown,
): OpenCodeOpenRouterMisconfiguration | null {
  const inspection = inspectOpenCodeOpenRouterEnv(env);
  if (!inspection.usesOpenAiCompatibleOpenRouterBaseUrl) return null;

  return {
    ...inspection,
    code: "opencode_openrouter_openai_compat_unsupported",
    message:
      "OpenRouter is configured through an OpenAI-compatible base URL, which `opencode_local` does not support.",
    detail:
      inspection.openAiCompatibleBaseUrlKey && inspection.openAiCompatibleBaseUrlValue
        ? `${inspection.openAiCompatibleBaseUrlKey}=${inspection.openAiCompatibleBaseUrlValue}`
        : null,
    hint: OPENCODE_NATIVE_OPENROUTER_HINT,
  };
}
