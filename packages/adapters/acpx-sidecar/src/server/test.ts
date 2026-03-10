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
  const urlValue = asString(config.url, "").trim();
  const agentCommand = asString(config.agentCommand, asString(config.command, "")).trim();
  const customAgentCommand = asString(config.customAgentCommand, "").trim();

  if (!urlValue) {
    checks.push({
      code: "acpx_sidecar_url_missing",
      level: "error",
      message: "ACPX sidecar adapter requires a sidecar URL.",
      hint: "Set adapterConfig.url to an absolute http(s) endpoint.",
    });
  } else {
    try {
      const url = new URL(urlValue);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        checks.push({
          code: "acpx_sidecar_url_protocol_invalid",
          level: "error",
          message: `Unsupported URL protocol: ${url.protocol}`,
        });
      } else {
        checks.push({
          code: "acpx_sidecar_url_valid",
          level: "info",
          message: `Configured sidecar endpoint: ${url.toString()}`,
        });
      }
    } catch {
      checks.push({
        code: "acpx_sidecar_url_invalid",
        level: "error",
        message: `Invalid URL: ${urlValue}`,
      });
    }
  }

  if (!agentCommand && !customAgentCommand) {
    checks.push({
      code: "acpx_sidecar_agent_command_missing",
      level: "error",
      message: "ACPX sidecar adapter requires agentCommand or customAgentCommand.",
      hint: "Set adapterConfig.agentCommand to a valid acpx runtime or adapterConfig.customAgentCommand to a raw ACP server command.",
    });
  } else if (customAgentCommand) {
    checks.push({
      code: "acpx_sidecar_custom_agent_command_configured",
      level: "info",
      message: `Configured custom ACP server: ${customAgentCommand}`,
    });
  } else {
    checks.push({
      code: "acpx_sidecar_agent_command_configured",
      level: "info",
      message: `Configured ACPX runtime: ${agentCommand}`,
    });
  }

  if (urlValue) {
    try {
      const response = await fetch(`${urlValue.replace(/\/+$/, "")}/health`, { method: "GET" });
      if (response.ok) {
        checks.push({
          code: "acpx_sidecar_health_ok",
          level: "info",
          message: "ACPX sidecar health endpoint responded.",
        });
      } else {
        checks.push({
          code: "acpx_sidecar_health_unexpected_status",
          level: "warn",
          message: `ACPX sidecar health endpoint returned HTTP ${response.status}.`,
        });
      }
    } catch (err) {
      checks.push({
        code: "acpx_sidecar_health_failed",
        level: "warn",
        message: err instanceof Error ? err.message : "ACPX sidecar probe failed",
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
