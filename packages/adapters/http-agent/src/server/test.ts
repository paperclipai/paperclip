import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const endpoint = asString(config.endpoint, "").replace(/\/+$/, "");
  const healthPath = asString(config.healthEndpoint, "/api/health");

  if (!endpoint) {
    checks.push({
      code: "http_agent_endpoint_missing",
      level: "error",
      message: "http_agent adapter requires an endpoint.",
      hint: "Set adapterConfig.endpoint to the agent's base URL.",
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
    url = new URL(endpoint);
  } catch {
    checks.push({
      code: "http_agent_endpoint_invalid",
      level: "error",
      message: `Invalid endpoint URL: ${endpoint}`,
    });
  }

  if (url && url.protocol !== "http:" && url.protocol !== "https:") {
    checks.push({
      code: "http_agent_endpoint_protocol_invalid",
      level: "error",
      message: `Unsupported protocol: ${url.protocol}. Use http:// or https://.`,
    });
  }

  if (url) {
    checks.push({
      code: "http_agent_endpoint_valid",
      level: "info",
      message: `Remote agent endpoint: ${url.toString()}`,
    });

    const authHeader = asString(config.authHeader, "").trim();
    if (authHeader) {
      checks.push({
        code: "http_agent_auth_configured",
        level: "info",
        message: "Auth header is configured.",
      });
    } else {
      checks.push({
        code: "http_agent_auth_missing",
        level: "warn",
        message: "No auth header configured.",
        hint: "Set adapterConfig.authHeader for authenticated endpoints.",
      });
    }

    // Probe health
    const healthUrl = `${endpoint}${healthPath}`;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const headers: Record<string, string> = {};
      if (authHeader) headers["authorization"] = authHeader;

      const res = await fetch(healthUrl, {
        method: "HEAD",
        headers,
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        checks.push({
          code: "http_agent_health_ok",
          level: "info",
          message: "Remote agent health check passed.",
        });
      } else if (res.status === 405 || res.status === 501) {
        // Method not allowed, try GET
        try {
          const controller2 = new AbortController();
          const timeout2 = setTimeout(() => controller2.abort(), 3000);
          const res2 = await fetch(healthUrl, {
            method: "GET",
            headers,
            signal: controller2.signal,
          });
          clearTimeout(timeout2);
          checks.push({
            code: res2.ok ? "http_agent_health_ok" : "http_agent_health_unexpected",
            level: res2.ok ? "info" : "warn",
            message: res2.ok
              ? "Remote agent health check (GET) passed."
              : `Health check returned HTTP ${res2.status}.`,
          });
        } catch {
          checks.push({
            code: "http_agent_health_failed",
            level: "warn",
            message: "Health check GET request failed.",
          });
        }
      } else {
        checks.push({
          code: "http_agent_health_unexpected",
          level: "warn",
          message: `Health check returned HTTP ${res.status}.`,
          hint: "The endpoint is reachable but health check is unexpected.",
        });
      }
    } catch (err) {
      checks.push({
        code: "http_agent_health_failed",
        level: "warn",
        message: "Could not reach remote agent health endpoint.",
        hint: `Verify agent is running at ${endpoint}. Error: ${err instanceof Error ? err.message : "unknown"}`,
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
