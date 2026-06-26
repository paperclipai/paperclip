import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";
import {
  allowsInsecureRemoteHttp,
  isLoopbackHostname,
  isRemotePlainHttp,
  remotePlainHttpDeniedMessage,
} from "./transport-security.js";

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

function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const cause = err instanceof Error ? (err as { cause?: unknown }).cause : null;
  if (!cause || typeof cause !== "object") return message;

  const causeRecord = cause as { code?: unknown; message?: unknown };
  const causeMessage = typeof causeRecord.message === "string" ? causeRecord.message : "";
  const causeCode = typeof causeRecord.code === "string" ? causeRecord.code : "";
  if (!causeMessage || causeMessage === message) return causeCode ? `${message} (${causeCode})` : message;
  return causeCode ? `${message} (${causeCode}: ${causeMessage})` : `${message} (${causeMessage})`;
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

  if (parsed && isRemotePlainHttp(parsed) && !allowsInsecureRemoteHttp(ctx.config)) {
    checks.push({
      code: "hermes_gateway_plain_http_remote_denied",
      level: "error",
      message: remotePlainHttpDeniedMessage(parsed.hostname),
      hint: "Use https:// for remote Hermes gateways. Loopback http://localhost and http://127.0.0.1 remain allowed.",
    });
  } else if (parsed && isRemotePlainHttp(parsed)) {
    checks.push({
      code: "hermes_gateway_plain_http_remote_unsafe_allowed",
      level: "warn",
      message: "Unsafe dev escape hatch enabled for non-loopback HTTP Hermes traffic.",
      hint: "Remove the escape hatch and use HTTPS before using this gateway for real credentials.",
    });
  } else if (parsed?.protocol === "http:" && isLoopbackHostname(parsed.hostname)) {
    checks.push({
      code: "hermes_gateway_loopback_http_allowed",
      level: "info",
      message: "Loopback HTTP Hermes gateway URL is allowed.",
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
      level: response.ok ? "info" : "error",
      message: response.ok
        ? "Hermes Gateway health endpoint is reachable."
        : `Hermes Gateway health endpoint returned HTTP ${response.status}.`,
      hint: response.ok
        ? undefined
        : "Check apiBaseUrl, API_SERVER_KEY, and that the Hermes API server is reachable from Paperclip.",
    });
  } catch (err) {
    checks.push({
      code: "hermes_gateway_health_unreachable",
      level: "error",
      message: "Could not reach Hermes Gateway health endpoint.",
      detail: errorDetail(err),
      hint: "Check apiBaseUrl and make sure the Hermes API server is running where Paperclip can reach it.",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
