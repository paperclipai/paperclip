import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function normalizeMethod(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed.toUpperCase() : "POST";
}

function runtimeHintFromHeaders(headers: Record<string, unknown>): string {
  const keys = ["x-agent-runtime", "x-runtime", "x-orchestrator"];
  for (const key of keys) {
    const value = headers[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return "";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const urlValue = asString(config.url, "");
  const method = normalizeMethod(asString(config.method, "POST"));
  const runtimeProfile = asString(config.runtimeProfile, "custom-http");
  const headers = parseObject(config.headers) as Record<string, unknown>;
  const runtimeHint = runtimeHintFromHeaders(headers);

  if (!urlValue) {
    checks.push({
      code: "http_url_missing",
      level: "error",
      message: "HTTP adapter requires a URL.",
      hint: "Set adapterConfig.url to an absolute http(s) endpoint.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  let url: URL | null = null;
  try {
    url = new URL(urlValue);
  } catch {
    checks.push({
      code: "http_url_invalid",
      level: "error",
      message: `Invalid URL: ${urlValue}`,
    });
  }

  if (url && url.protocol !== "http:" && url.protocol !== "https:") {
    checks.push({
      code: "http_url_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${url.protocol}`,
      hint: "Use an http:// or https:// endpoint.",
    });
  }

  if (url) {
    checks.push({
      code: "http_url_valid",
      level: "info",
      message: `Configured endpoint: ${url.toString()}`,
    });
  }

  checks.push({
    code: "http_method_configured",
    level: "info",
    message: `Configured method: ${method}`,
  });

  if (runtimeProfile === "http+crewai") {
    checks.push({
      code: "http_runtime_profile_crewai",
      level: "info",
      message: "Runtime profile set to HTTP + CrewAI.",
    });
    if (!runtimeHint.toLowerCase().includes("crewai")) {
      checks.push({
        code: "http_runtime_profile_crewai_hint_missing",
        level: "warn",
        message: "CrewAI profile configured without x-agent-runtime CrewAI header.",
        hint: 'Set adapterConfig.headers["x-agent-runtime"] = "CrewAI".',
      });
    }
  } else if (runtimeProfile === "http+langgraph") {
    checks.push({
      code: "http_runtime_profile_langgraph",
      level: "info",
      message: "Runtime profile set to HTTP + LangGraph.",
    });
  } else {
    checks.push({
      code: "http_runtime_profile_custom",
      level: "info",
      message: "Runtime profile set to custom-http.",
    });
  }

  if (url && (url.protocol === "http:" || url.protocol === "https:")) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: controller.signal,
      });
      if (!response.ok && response.status !== 405 && response.status !== 501) {
        checks.push({
          code: "http_endpoint_probe_unexpected_status",
          level: "warn",
          message: `Endpoint probe returned HTTP ${response.status}.`,
          hint: "Verify the endpoint is reachable from the Paperclip server host.",
        });
      } else {
        checks.push({
          code: "http_endpoint_probe_ok",
          level: "info",
          message: "Endpoint responded to a HEAD probe.",
        });
      }
    } catch (err) {
      checks.push({
        code: "http_endpoint_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "Endpoint probe failed",
        hint: "This may be expected in restricted networks; verify connectivity when invoking runs.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  if (url && runtimeProfile === "http+crewai") {
    const healthUrl = `${url.protocol}//${url.host}/health`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(healthUrl, {
        method: "GET",
        signal: controller.signal,
      });
      if (response.ok) {
        checks.push({
          code: "http_crewai_health_probe_ok",
          level: "info",
          message: `CrewAI health probe succeeded at ${healthUrl}`,
        });
      } else {
        checks.push({
          code: "http_crewai_health_probe_status",
          level: "warn",
          message: `CrewAI health probe returned HTTP ${response.status}`,
          hint: "Verify your CrewAI webhook runtime exposes /health.",
        });
      }
    } catch (err) {
      checks.push({
        code: "http_crewai_health_probe_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "CrewAI health probe failed",
        hint: "Start the CrewAI webhook runtime before invoking heartbeat.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
