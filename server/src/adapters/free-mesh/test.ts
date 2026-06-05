import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";
import { FREE_MESH_DATA_POLICY } from "./constants.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function readEnv(config: Record<string, unknown>): Record<string, unknown> {
  return parseObject(config.env);
}

function readConfigString(
  config: Record<string, unknown>,
  env: Record<string, unknown>,
  key: string,
  envKey: string,
): string {
  return asString(config[key], "") || asString(env[envKey], "") || process.env[envKey]?.trim() || "";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const env = readEnv(config);

  const dataPolicy = asString(config.dataPolicy, "");
  if (dataPolicy !== FREE_MESH_DATA_POLICY) {
    checks.push({
      code: "free_mesh_data_policy_missing",
      level: "error",
      message: `free-mesh requires dataPolicy="${FREE_MESH_DATA_POLICY}".`,
      hint: "Only configure this adapter for low-stakes public validation/research roles.",
    });
  } else {
    checks.push({
      code: "free_mesh_data_policy_acknowledged",
      level: "info",
      message: "Data policy acknowledged: low-stakes public only.",
    });
  }

  const baseUrl = readConfigString(config, env, "baseUrl", "FREE_MESH_BASE_URL");
  if (!baseUrl) {
    checks.push({
      code: "free_mesh_base_url_missing",
      level: "error",
      message: "free-mesh requires baseUrl or env.FREE_MESH_BASE_URL.",
    });
  } else {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        checks.push({
          code: "free_mesh_base_url_protocol_invalid",
          level: "error",
          message: `Unsupported URL protocol: ${url.protocol}`,
        });
      } else {
        checks.push({
          code: "free_mesh_base_url_valid",
          level: "info",
          message: `Configured LiteLLM base URL: ${url.toString()}`,
        });
      }
    } catch {
      checks.push({
        code: "free_mesh_base_url_invalid",
        level: "error",
        message: `Invalid LiteLLM base URL: ${baseUrl}`,
      });
    }
  }

  const apiKey = readConfigString(config, env, "apiKey", "FREE_MESH_API_KEY");
  checks.push({
    code: apiKey ? "free_mesh_api_key_configured" : "free_mesh_api_key_missing",
    level: apiKey ? "info" : "error",
    message: apiKey
      ? "API key is configured; value is not displayed."
      : "free-mesh requires apiKey or env.FREE_MESH_API_KEY.",
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
