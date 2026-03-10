import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const url = typeof ctx.config.url === "string" ? ctx.config.url.trim() : "";
  const checks: AdapterEnvironmentCheck[] = [];

  if (!url) {
    checks.push({
      code: "hermes_gateway_url_missing",
      level: "error",
      message: "Hermes gateway URL is required.",
    });
  } else if (!/^wss?:\/\//i.test(url)) {
    checks.push({
      code: "hermes_gateway_url_invalid",
      level: "error",
      message: "Hermes gateway URL must start with ws:// or wss://",
      detail: url,
    });
  } else {
    checks.push({
      code: "hermes_gateway_url_valid",
      level: "info",
      message: `Hermes gateway URL looks valid: ${url}`,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: checks.some((check) => check.level === "error") ? "fail" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}
