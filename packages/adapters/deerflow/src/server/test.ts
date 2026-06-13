import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

async function probeUrl(
  url: string,
  label: string,
  checks: AdapterEnvironmentCheck[],
  signal: AbortSignal,
): Promise<void> {
  try {
    const res = await fetch(url, { method: "GET", signal });
    if (res.ok || res.status === 404 || res.status === 405) {
      checks.push({
        code: `deerflow_${label}_reachable`,
        level: "info",
        message: `${label} responded (HTTP ${res.status}) at ${url}`,
      });
    } else {
      checks.push({
        code: `deerflow_${label}_unexpected_status`,
        level: "warn",
        message: `${label} returned HTTP ${res.status}`,
        hint: `Verify ${label} is running and accessible from the Paperclip server.`,
      });
    }
  } catch (err) {
    checks.push({
      code: `deerflow_${label}_unreachable`,
      level: "error",
      message: `${label} not reachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      hint: `Ensure the DeerFlow ${label} service is running. If using Docker, verify network connectivity.`,
    });
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const deerflowUrl = asString(config.deerflowUrl as unknown, "http://deerflow-langgraph:2024");
  const gatewayUrl = asString(config.gatewayUrl as unknown, "http://deerflow-gateway:8001");

  checks.push({
    code: "deerflow_langgraph_url",
    level: "info",
    message: `LangGraph URL: ${deerflowUrl}`,
  });
  checks.push({
    code: "deerflow_gateway_url",
    level: "info",
    message: `Gateway URL: ${gatewayUrl}`,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    // Probe LangGraph API
    await probeUrl(`${deerflowUrl}/ok`, "LangGraph", checks, controller.signal);

    // Probe Gateway health endpoint
    await probeUrl(`${gatewayUrl}/health`, "Gateway", checks, controller.signal);

    // Check models availability via Gateway
    try {
      const modelsRes = await fetch(`${gatewayUrl}/api/models`, {
        method: "GET",
        signal: controller.signal,
      });
      if (modelsRes.ok) {
        const modelsData = (await modelsRes.json()) as { models?: unknown[] };
        const count = Array.isArray(modelsData.models) ? modelsData.models.length : 0;
        checks.push({
          code: "deerflow_models_available",
          level: count > 0 ? "info" : "warn",
          message: count > 0 ? `${count} model(s) available` : "No models configured in DeerFlow",
          hint: count === 0 ? "Add model entries to deerflow/config.yaml" : undefined,
        });
      }
    } catch {
      // Gateway model check is optional — already checked reachability above
    }
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
