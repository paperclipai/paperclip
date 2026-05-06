import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { deriveAgentZeroHealthUrl, parseAgentZeroBridgeConfig } from "./config.js";
import { parseObject } from "../utils.js";

function summarizeStatus(
  checks: AdapterEnvironmentCheck[],
): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function info(code: string, message: string, detail?: string): AdapterEnvironmentCheck {
  return { code, level: "info", message, detail };
}

function warn(code: string, message: string, detail?: string): AdapterEnvironmentCheck {
  return { code, level: "warn", message, detail };
}

function fail(code: string, message: string, detail?: string): AdapterEnvironmentCheck {
  return { code, level: "error", message, detail };
}

export async function testAgentZeroBridgeEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  let config;
  try {
    config = parseAgentZeroBridgeConfig(ctx.config);
  } catch (error) {
    return {
      adapterType: ctx.adapterType,
      status: "fail",
      checks: [
        fail(
          "agent_zero_bridge_config_invalid",
          error instanceof Error ? error.message : "Invalid Agent Zero bridge configuration",
        ),
      ],
      testedAt: new Date().toISOString(),
    };
  }

  const checks: AdapterEnvironmentTestResult["checks"] = [
    info("agent_zero_bridge_invoke_url_configured", "Invoke URL configured", config.url),
  ];

  const healthUrl = config.healthUrl || deriveAgentZeroHealthUrl(config.url);
  if (!/\/invoke\/?$/i.test(new URL(config.url).pathname)) {
    checks.push(
      warn(
        "agent_zero_bridge_invoke_url_nonstandard",
        "Invoke URL does not end with /invoke",
        "The bundled Agent Zero bridge listens on POST /invoke. Custom bridges can ignore this warning.",
      ),
    );
  }

  try {
    const response = await fetch(healthUrl, { method: "GET" });
    if (!response.ok) {
      checks.push(
        warn(
          "agent_zero_bridge_health_non_success",
          "Health endpoint returned a non-success status",
          `${response.status} ${response.statusText}`,
        ),
      );
    } else {
      const json = parseObject(await response.json().catch(() => ({})));
      const detail = Object.entries(json)
        .slice(0, 4)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(", ");
      checks.push(
        info("agent_zero_bridge_health_ok", "Health endpoint responded", detail || healthUrl),
      );
    }
  } catch (error) {
    checks.push(
      warn(
        "agent_zero_bridge_health_unreachable",
        "Could not reach the bridge health endpoint",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
