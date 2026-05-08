import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { DEFAULT_OPENROUTER_LOCAL_BASE_URL } from "../index.js";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];

  const baseUrl = String(ctx.config?.baseUrl ?? DEFAULT_OPENROUTER_LOCAL_BASE_URL);
  const apiKey =
    process.env.OPENROUTER_API_KEY ?? process.env.OPENAI_API_KEY ?? "";

  if (!baseUrl.startsWith("https://")) {
    checks.push({
      level: "error",
      message: `baseUrl must be HTTPS: ${baseUrl}`,
      code: "invalid_baseurl",
    });
  } else {
    checks.push({
      level: "info",
      message: `baseUrl: ${baseUrl}`,
      code: "baseurl_ok",
    });
  }

  if (!apiKey) {
    checks.push({
      level: "error",
      message: "OPENROUTER_API_KEY (or OPENAI_API_KEY) not set",
      hint: "Set it in the agent's env inputs or in the Paperclip server's environment.",
      code: "missing_api_key",
    });
  } else {
    checks.push({
      level: "info",
      message: "API key present",
      code: "api_key_present",
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: checks.some((c) => c.level === "error") ? "fail" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
