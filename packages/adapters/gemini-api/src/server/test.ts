import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = ctx.config;
  const envConfig = typeof config.env === "object" && config.env !== null ? config.env as Record<string, unknown> : {};
  const configApiKey = asString(envConfig.GEMINI_API_KEY, "").trim();
  const processApiKey = asString(process.env.GEMINI_API_KEY, "").trim();
  const hasApiKey = configApiKey.length > 0 || processApiKey.length > 0;

  const checks = [
    {
      code: "gemini_api_key",
      level: hasApiKey ? ("info" as const) : ("error" as const),
      message: hasApiKey
        ? `GEMINI_API_KEY present (length=${(configApiKey || processApiKey).length})`
        : "GEMINI_API_KEY is not set. Configure it as a Paperclip-managed secret.",
    },
  ];

  const status = checks.some((c) => c.level === "error") ? "fail" : "pass";

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
