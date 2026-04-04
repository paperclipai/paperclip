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
  const envConfig = parseObject(config.env ?? {});
  
  // Check 1: API Key
  const apiKey = typeof envConfig.DASHSCOPE_API_KEY === "string" ? envConfig.DASHSCOPE_API_KEY : process.env.DASHSCOPE_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    checks.push({
      code: "dashscope_api_key_missing",
      level: "error",
      message: "DashScope API key not found",
      hint: "Set DASHSCOPE_API_KEY in config.env or environment variables",
    });
  } else {
    checks.push({
      code: "dashscope_api_key_present",
      level: "info",
      message: "DashScope API key is configured",
      detail: "Using OpenAI-compatible endpoint: https://coding.dashscope.aliyuncs.com/v1",
    });
  }
  
  // Check 2: Model
  const model = asString(config.model, "");
  if (!model) {
    checks.push({
      code: "dashscope_model_missing",
      level: "warn",
      message: "No model specified in config",
      hint: "Set config.model to a valid DashScope model (e.g., qwen-max, qwen-plus)",
    });
  } else {
    checks.push({
      code: "dashscope_model_configured",
      level: "info",
      message: `Model configured: ${model}`,
    });
  }
  
  // Check 3: CWD
  const cwd = asString(config.cwd, process.cwd());
  try {
    await import("node:fs/promises").then(fs => fs.access(cwd));
    checks.push({
      code: "dashscope_cwd_valid",
      level: "info",
      message: `Working directory is accessible: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "dashscope_cwd_invalid",
      level: "error",
      message: "Working directory is not accessible",
      detail: cwd,
    });
  }
  
  return {
    adapterType: "dashscope_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
