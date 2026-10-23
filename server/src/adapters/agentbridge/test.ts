import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString } from "../utils.js";
import { guardedHttpAdapterFetch } from "../http/remote-fetch.js";

const ALLOWLIST_HINT =
  "Start AgentBridge (agent --headless) or point url at a reachable address. Loopback and private origins must be listed in PAPERCLIP_HTTP_ADAPTER_PRIVATE_ENDPOINT_ALLOWLIST.";

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const baseUrl = asString(ctx.config.url, "http://localhost:5290").replace(/\/+$/, "");
  const apiKey = asString(ctx.config.apiKey, "");
  const headers: Record<string, string> = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  const checks: AdapterEnvironmentCheck[] = [];
  let status: AdapterEnvironmentTestResult["status"] = "pass";

  try {
    const res = await guardedHttpAdapterFetch(`${baseUrl}/health`, {
      method: "GET",
      headers,
    });
    if (res.ok) {
      checks.push({
        code: "health_ok",
        level: "info",
        message: `AgentBridge is reachable at ${baseUrl}/health`,
      });
    } else {
      checks.push({
        code: "health_bad",
        level: "error",
        message: `AgentBridge /health returned ${res.status}`,
        hint: ALLOWLIST_HINT,
      });
      status = "fail";
    }
  } catch (err) {
    checks.push({
      code: "health_unreachable",
      level: "error",
      message: `Could not reach AgentBridge at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
      hint: ALLOWLIST_HINT,
    });
    status = "fail";
  }

  if (status !== "fail") {
    try {
      const res = await guardedHttpAdapterFetch(`${baseUrl}/v1/models`, {
        method: "GET",
        headers,
      });
      if (res.ok) {
        checks.push({
          code: "models_ok",
          level: "info",
          message: "AgentBridge reported its agent-set catalog",
        });
      } else {
        checks.push({
          code: "models_bad",
          level: "warn",
          message: `AgentBridge /v1/models returned ${res.status}`,
        });
        status = "warn";
      }
    } catch {
      checks.push({
        code: "models_unreachable",
        level: "warn",
        message: "Could not read the AgentBridge agent-set catalog",
      });
      status = "warn";
    }
  }

  return { adapterType: "agentbridge", status, checks, testedAt: new Date().toISOString() };
}
