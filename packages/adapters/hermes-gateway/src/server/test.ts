import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeBaseUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

function isLoopback(hostname: string): boolean {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "::1";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const apiBaseUrl = asString(ctx.config.apiBaseUrl ?? ctx.config.url, "").trim();
  const apiKey = asString(ctx.config.apiKey ?? ctx.config.token, "").trim();

  if (!apiBaseUrl) {
    checks.push({
      code: "hermes_gateway_api_base_url_missing",
      level: "error",
      message: "Hermes Gateway requires apiBaseUrl.",
      hint: "Enable Hermes API server and set apiBaseUrl, for example http://127.0.0.1:8642.",
    });
  }

  const parsed = apiBaseUrl ? normalizeBaseUrl(apiBaseUrl) : null;
  if (apiBaseUrl && !parsed) {
    checks.push({
      code: "hermes_gateway_api_base_url_invalid",
      level: "error",
      message: "apiBaseUrl must be an http:// or https:// URL.",
    });
  }

  if (!apiKey) {
    checks.push({
      code: "hermes_gateway_api_key_missing",
      level: "error",
      message: "Hermes Gateway requires apiKey.",
      hint: "Set Hermes API_SERVER_KEY and copy the same value into adapterConfig.apiKey.",
    });
  }

  if (parsed?.protocol === "http:" && !isLoopback(parsed.hostname)) {
    checks.push({
      code: "hermes_gateway_plain_http_remote",
      level: "warn",
      message: "Non-loopback HTTP exposes Hermes traffic without transport encryption.",
      hint: "Prefer HTTPS or a private overlay network for remote Hermes hosts.",
    });
  }

  if (checks.some((check) => check.level === "error") || !parsed || !apiKey) {
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  try {
    const healthUrl = new URL("/health", parsed);
    const response = await fetch(healthUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(2_000),
    });
    checks.push({
      code: response.ok ? "hermes_gateway_health_ok" : "hermes_gateway_health_failed",
      level: response.ok ? "info" : "warn",
      message: response.ok
        ? "Hermes Gateway health endpoint is reachable."
        : `Hermes Gateway health endpoint returned HTTP ${response.status}.`,
    });
  } catch (err) {
    checks.push({
      code: "hermes_gateway_health_unreachable",
      level: "warn",
      message: "Could not reach Hermes Gateway health endpoint.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

