import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { OPENAI_COMPATIBLE_API_KEY_ENV, normalizeOpenAiCompatibleApiUrl } from "../index.js";
import { buildRequestHeaders, createChatCompletion } from "./client.js";
import { asStringEnvMap, readExtraHeaders } from "./execute.js";

const PROBE_TIMEOUT_MS = 30_000;

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

async function listProviderModels(
  apiUrl: string,
  apiKey: string,
  extraHeaders: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<string[] | null> {
  try {
    const response = await fetchImpl(`${apiUrl}/models`, {
      method: "GET",
      headers: buildRequestHeaders(apiKey, extraHeaders),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = parseObject(await response.json());
    const data = Array.isArray(payload.data) ? payload.data : [];
    return data
      .map((entry) => parseObject(entry).id)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch {
    return null;
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
  options: { fetchImpl?: typeof fetch } = {},
): Promise<AdapterEnvironmentTestResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const env = asStringEnvMap(config.env);
  const rawApiUrl = asString(config.apiUrl, "").trim();
  const apiUrl = normalizeOpenAiCompatibleApiUrl(rawApiUrl);
  const model = asString(config.model, "").trim();
  const apiKey = asString(env[OPENAI_COMPATIBLE_API_KEY_ENV], "").trim();
  const extraHeaders = readExtraHeaders(config.extraHeaders);

  if (!rawApiUrl) {
    checks.push({
      code: "openai_compatible_api_url_missing",
      level: "error",
      message: "API URL is required.",
      hint: "Enter the provider base URL, e.g. https://openrouter.ai/api/v1.",
    });
  } else if (!apiUrl) {
    checks.push({
      code: "openai_compatible_api_url_invalid",
      level: "error",
      message: "API URL must be an http(s) URL.",
      detail: rawApiUrl,
    });
  } else {
    checks.push({ code: "openai_compatible_api_url_valid", level: "info", message: `API URL: ${apiUrl}` });
    if (apiUrl.startsWith("http://")) {
      const host = new URL(apiUrl).hostname;
      if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
        checks.push({
          code: "openai_compatible_api_url_plain_http",
          level: "warn",
          message: "API URL uses plain http; the API key and prompts are sent unencrypted.",
        });
      }
    }
  }

  if (!model) {
    checks.push({
      code: "openai_compatible_model_missing",
      level: "error",
      message: "Model is required.",
      hint: "Enter the provider's model id, e.g. deepseek/deepseek-chat.",
    });
  }

  if (!apiKey) {
    checks.push({
      code: "openai_compatible_api_key_missing",
      level: "warn",
      message: `${OPENAI_COMPATIBLE_API_KEY_ENV} is not set; requests are sent without Authorization.`,
      hint: "Hosted providers require a key. Local servers such as Ollama or LM Studio usually do not.",
    });
  }

  if (apiUrl && model) {
    const providerModels = await listProviderModels(apiUrl, apiKey, extraHeaders, fetchImpl);
    if (providerModels && providerModels.length > 0) {
      const found = providerModels.includes(model);
      checks.push({
        code: found ? "openai_compatible_model_listed" : "openai_compatible_model_not_listed",
        level: found ? "info" : "warn",
        message: found
          ? `Model "${model}" is listed by the provider.`
          : `Model "${model}" is not in the provider's /models list (${providerModels.length} models).`,
        hint: found ? null : "Some providers accept aliases that are not listed; the probe below is authoritative.",
      });
    }

    try {
      const response = await createChatCompletion({
        apiUrl,
        apiKey,
        model,
        messages: [{ role: "user", content: "Respond with hello." }],
        maxTokens: 16,
        extraHeaders,
        timeoutMs: PROBE_TIMEOUT_MS,
        fetchImpl,
      });
      checks.push({
        code: "openai_compatible_hello_probe_passed",
        level: "info",
        message: `Chat completion succeeded${response.model ? ` (${response.model})` : ""}.`,
        detail: response.content.trim().slice(0, 200) || null,
      });
    } catch (err) {
      checks.push({
        code: "openai_compatible_hello_probe_failed",
        level: "error",
        message: err instanceof Error ? err.message : "Chat completion probe failed.",
        hint: "Check the API URL, model id, and API key.",
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
