import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentCheck,
} from "@paperclipai/adapter-utils";

const NANOCLAW_DEFAULT_URL = "http://127.0.0.1:18790";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config =
    typeof ctx.config === "object" && ctx.config !== null && !Array.isArray(ctx.config)
      ? (ctx.config as Record<string, unknown>)
      : {};

  const baseUrl =
    typeof config.url === "string" && config.url.trim() ? config.url.trim() : NANOCLAW_DEFAULT_URL;

  const healthUrl = `${baseUrl.replace(/\/+$/, "")}/health`;
  const checks: AdapterEnvironmentCheck[] = [];
  const testedAt = new Date().toISOString();

  try {
    const response = await fetch(healthUrl, {
      method: "GET",
      signal: AbortSignal.timeout(5_000),
    });

    if (response.ok) {
      checks.push({
        code: "nanoclaw_reachable",
        level: "info",
        message: `NanoClaw MCP server reachable at ${baseUrl}`,
      });
    } else {
      checks.push({
        code: "nanoclaw_unhealthy",
        level: "error",
        message: `NanoClaw health check returned HTTP ${response.status}`,
        hint: "Verify NanoClaw is running and the URL is correct",
      });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "nanoclaw_unreachable",
      level: "error",
      message: `Cannot reach NanoClaw at ${baseUrl}: ${message}`,
      hint: "Check that NanoClaw service is running (launchctl list com.nanoclaw) and port 18790 is not blocked",
    });
  }

  const hasError = checks.some((c) => c.level === "error");
  const hasWarn = checks.some((c) => c.level === "warn");

  return {
    adapterType: "nanoclaw_gateway",
    status: hasError ? "fail" : hasWarn ? "warn" : "pass",
    checks,
    testedAt,
  };
}
