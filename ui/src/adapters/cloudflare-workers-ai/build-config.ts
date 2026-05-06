import type { CreateConfigValues } from "../../components/AgentConfigForm";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(values: CreateConfigValues, key: string): string {
  return typeof values.adapterSchemaValues?.[key] === "string"
    ? String(values.adapterSchemaValues?.[key]).trim()
    : "";
}

function readOptionalPositiveNumber(values: CreateConfigValues, key: string): number | null {
  const raw = asRecord(values.adapterSchemaValues)[key];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number.parseFloat(raw.trim());
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function readOptionalNumber(
  values: CreateConfigValues,
  key: string,
  options?: { allowZero?: boolean },
): number | null {
  const raw = asRecord(values.adapterSchemaValues)[key];
  if (typeof raw === "number" && Number.isFinite(raw) && (options?.allowZero ? raw >= 0 : raw > 0)) {
    return raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Number.parseFloat(raw.trim());
    if (Number.isFinite(parsed) && (options?.allowZero ? parsed >= 0 : parsed > 0)) {
      return parsed;
    }
  }
  return null;
}

export function buildCloudflareWorkersAiConfig(v: CreateConfigValues): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  const accountId = readString(v, "accountId");
  const apiToken = readString(v, "apiToken");
  const gatewayId = readString(v, "gatewayId");
  const timeoutSec = readOptionalPositiveNumber(v, "timeoutSec");
  const maxCompletionTokens = readOptionalPositiveNumber(v, "maxCompletionTokens");
  const temperature = readOptionalNumber(v, "temperature", { allowZero: true });

  if (accountId) config.accountId = accountId;
  if (apiToken) config.apiToken = apiToken;
  if (gatewayId) config.gatewayId = gatewayId;
  if (v.instructionsFilePath?.trim()) config.instructionsFilePath = v.instructionsFilePath.trim();
  if (v.promptTemplate?.trim()) config.promptTemplate = v.promptTemplate.trim();
  if (v.model.trim()) config.model = v.model.trim();
  if (timeoutSec) config.timeoutSec = timeoutSec;
  if (maxCompletionTokens) config.maxCompletionTokens = Math.floor(maxCompletionTokens);
  if (temperature !== null) config.temperature = temperature;

  if (!("timeoutSec" in config)) config.timeoutSec = 120;

  return config;
}
