import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_ENDPOINT = "http://localhost:18789";

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
  const endpoint = asString(config.endpoint, DEFAULT_ENDPOINT).replace(/\/+$/, "");

  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    checks.push({
      code: "openclaw_local_endpoint_invalid",
      level: "error",
      message: `Invalid endpoint URL: ${endpoint}`,
    });
  }

  if (url && url.protocol !== "http:" && url.protocol !== "https:") {
    checks.push({
      code: "openclaw_local_endpoint_protocol_invalid",
      level: "error",
      message: `Unsupported protocol: ${url.protocol}. Use http:// or https://.`,
    });
  }

  if (url) {
    checks.push({
      code: "openclaw_local_endpoint_valid",
      level: "info",
      message: `OpenClaw gateway endpoint: ${url.toString()}`,
    });

    // Probe health
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${endpoint}/api/health`, {
        method: "GET",
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) {
        checks.push({
          code: "openclaw_local_gateway_reachable",
          level: "info",
          message: "OpenClaw gateway is reachable and healthy.",
        });
      } else {
        checks.push({
          code: "openclaw_local_gateway_unhealthy",
          level: "warn",
          message: `OpenClaw gateway returned HTTP ${res.status}.`,
          hint: "Verify the gateway is running on the configured port.",
        });
      }
    } catch (err) {
      checks.push({
        code: "openclaw_local_gateway_unreachable",
        level: "warn",
        message: "Could not reach OpenClaw gateway.",
        hint: `Verify OpenClaw is running at ${endpoint}. Error: ${err instanceof Error ? err.message : "unknown"}`,
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
