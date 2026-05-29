import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_BASE_URL = "https://api.deepseek.com/v1";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function resolveApiKey(config: Record<string, unknown>): string | null {
  const env = parseObject(config.env);
  return nonEmpty(env.DEEPSEEK_API_KEY) ?? nonEmpty(config.apiKey);
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const baseUrlValue = asString(config.baseUrl, DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  let baseUrl: URL | null = null;
  try {
    baseUrl = new URL(baseUrlValue);
  } catch {
    checks.push({
      code: "deepseek_base_url_invalid",
      level: "error",
      message: `Invalid base URL: ${baseUrlValue}`,
    });
  }

  if (baseUrl && baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
    checks.push({
      code: "deepseek_base_url_protocol_invalid",
      level: "error",
      message: `Unsupported base URL protocol: ${baseUrl.protocol}`,
      hint: "Use https://api.deepseek.com/v1 unless proxying through an internal gateway.",
    });
  }

  if (baseUrl) {
    checks.push({
      code: "deepseek_base_url",
      level: "info",
      message: `Configured base URL: ${baseUrl.toString()}`,
    });
  }

  const apiKey = resolveApiKey(config);
  if (!apiKey) {
    checks.push({
      code: "deepseek_api_key_missing",
      level: "error",
      message: "DeepSeek API key is not set.",
      hint: "Set adapterConfig.env.DEEPSEEK_API_KEY to a key from https://platform.deepseek.com.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "deepseek_api_key_present",
    level: "info",
    message: `API key present (length ${apiKey.length}).`,
  });

  if (baseUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const probeUrl = `${baseUrl.toString().replace(/\/$/, "")}/models`;
      const response = await fetch(probeUrl, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        checks.push({
          code: "deepseek_api_key_unauthorized",
          level: "error",
          message: `DeepSeek API rejected the key (HTTP ${response.status}).`,
          hint: "Verify DEEPSEEK_API_KEY at https://platform.deepseek.com/api_keys.",
        });
      } else if (!response.ok) {
        checks.push({
          code: "deepseek_probe_unexpected_status",
          level: "warn",
          message: `Models probe returned HTTP ${response.status}.`,
          hint: "Endpoint reachable but returned non-2xx; verify when invoking runs.",
        });
      } else {
        checks.push({
          code: "deepseek_probe_ok",
          level: "info",
          message: "DeepSeek API key validated against /models endpoint.",
        });
      }
    } catch (err) {
      checks.push({
        code: "deepseek_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "DeepSeek probe failed",
        hint: "Network or DNS error reaching DeepSeek; verify connectivity from the Paperclip server host.",
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
