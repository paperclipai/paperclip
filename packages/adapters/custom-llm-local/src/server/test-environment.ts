import type { AdapterEnvironmentCheck, AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "@paperclipai/adapter-utils";
import { parseConfig } from "../schema.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];

  let config;
  try {
    config = parseConfig(ctx.config as Record<string, unknown>);
  } catch (err) {
    checks.push({
      code: "custom_llm_local_config_invalid",
      level: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    return { adapterType: ctx.adapterType, status: "fail", checks, testedAt: new Date().toISOString() };
  }

  checks.push({ code: "custom_llm_local_config_valid", level: "info", message: `Config valid: transport=${config.transport}, baseUrl=${config.baseUrl}, model=${config.model}` });

  if (config.apiKeyEnv) {
    const keyValue = process.env[config.apiKeyEnv] ?? "";
    if (!keyValue) {
      checks.push({
        code: "custom_llm_local_api_key_missing",
        level: "warn",
        message: `apiKeyEnv "${config.apiKeyEnv}" is not set in server environment`,
        hint: `Set ${config.apiKeyEnv} in the server process environment before running agents`,
      });
    } else {
      checks.push({ code: "custom_llm_local_api_key_present", level: "info", message: `apiKeyEnv "${config.apiKeyEnv}" is set` });
    }
  } else {
    checks.push({ code: "custom_llm_local_no_api_key_env", level: "info", message: "No apiKeyEnv configured — endpoint will be called without Authorization header" });
  }

  return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
}
