import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const apiBaseUrl = asString(config.apiBaseUrl, "http://localhost:1234/v1");

  let url: URL | null = null;
  try {
    url = new URL(apiBaseUrl);
  } catch {
    checks.push({
      code: "lmstudio_url_invalid",
      level: "error",
      message: `Invalid API Base URL: ${apiBaseUrl}`,
      hint: "Should be a valid URL like http://localhost:1234/v1",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "lmstudio_url_configured",
    level: "info",
    message: `API Base URL: ${apiBaseUrl}`,
  });

  // Probe the /models endpoint to verify LM Studio is running
  const modelsUrl = `${apiBaseUrl.replace(/\/+$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(modelsUrl, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${asString(config.apiKey, "lm-studio")}`,
      },
      signal: controller.signal,
    });

    if (res.ok) {
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      const modelCount = data.data?.length ?? 0;
      checks.push({
        code: "lmstudio_server_reachable",
        level: "info",
        message: `LM Studio is running with ${modelCount} model(s) loaded.`,
      });
    } else {
      checks.push({
        code: "lmstudio_server_error",
        level: "warn",
        message: `LM Studio responded with HTTP ${res.status}.`,
        hint: "Make sure LM Studio is running and the server is started.",
      });
    }
  } catch (err) {
    checks.push({
      code: "lmstudio_server_unreachable",
      level: "warn",
      message: err instanceof Error ? err.message : "Could not reach LM Studio server",
      hint: "Start LM Studio and enable the local server (default port 1234).",
    });
  } finally {
    clearTimeout(timeout);
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
