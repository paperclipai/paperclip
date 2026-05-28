import type {
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const baseUrl = asString(config.url, "").replace(/\/$/, "");
  const checks: AdapterEnvironmentTestResult["checks"] = [];

  if (!baseUrl) {
    checks.push({
      code: "url_missing",
      level: "error",
      message: "url is required",
      hint: "Set url to your Golem XIV server address, e.g. http://localhost:8081",
    });
    return { adapterType: "golem_knowledge", status: "fail", checks, testedAt: new Date().toISOString() };
  }

  try {
    const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    if (res.ok && body.trim() === "OK") {
      checks.push({
        code: "health_ok",
        level: "info",
        message: `Golem XIV reachable at ${baseUrl}`,
      });
    } else {
      checks.push({
        code: "health_unexpected",
        level: "warn",
        message: `Golem XIV /health returned ${res.status}: ${body.slice(0, 100)}`,
      });
    }
  } catch (err) {
    checks.push({
      code: "health_unreachable",
      level: "error",
      message: `Cannot reach Golem XIV at ${baseUrl}`,
      detail: err instanceof Error ? err.message : String(err),
      hint: "Start Golem XIV: cd /workspace/golem-xiv && source /workspace/my-app/.env && ./gradlew :golem-xiv-server:run",
    });
    return { adapterType: "golem_knowledge", status: "fail", checks, testedAt: new Date().toISOString() };
  }

  const hasErrors = checks.some((c) => c.level === "error");
  const hasWarns = checks.some((c) => c.level === "warn");
  const status = hasErrors ? "fail" : hasWarns ? "warn" : "pass";

  return { adapterType: "golem_knowledge", status, checks, testedAt: new Date().toISOString() };
}
