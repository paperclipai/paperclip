import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const model = asString(config.model, "");
  if (model) {
    checks.push({ code: "model_configured", level: "info", message: `Model: ${model}` });
  } else {
    checks.push({ code: "model_missing", level: "warn", message: "No model configured. Will use default: deepseek/deepseek-v3.2" });
  }

  // Check API key
  const envConfig = parseObject(config.env);
  let hasKey = false;
  for (const k of ["OPENROUTER_API_KEY", "OPENAI_API_KEY"]) {
    if (typeof envConfig[k] === "string" && envConfig[k]) { hasKey = true; break; }
  }
  if (!hasKey) {
    hasKey = !!(process.env.OPENROUTER_API_KEY || process.env.OPENAI_API_KEY);
  }

  if (hasKey) {
    checks.push({ code: "api_key_found", level: "info", message: "OpenRouter API key is configured." });
  } else {
    checks.push({
      code: "api_key_missing",
      level: "error",
      message: "No OpenRouter API key found.",
      hint: "Set OPENROUTER_API_KEY in the environment or in adapter config env.",
    });
  }

  // Test connectivity
  try {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      method: "GET",
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      checks.push({ code: "connectivity_ok", level: "info", message: "OpenRouter API is reachable." });
    } else {
      checks.push({ code: "connectivity_error", level: "warn", message: `OpenRouter returned ${response.status}.` });
    }
  } catch {
    checks.push({
      code: "connectivity_failed",
      level: "warn",
      message: "Could not reach OpenRouter API.",
      hint: "Check network connectivity.",
    });
  }

  const status = checks.some(c => c.level === "error") ? "fail"
    : checks.some(c => c.level === "warn") ? "warn"
    : "pass";

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
