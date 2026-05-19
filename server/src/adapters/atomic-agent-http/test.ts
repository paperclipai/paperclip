import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "../utils.js";
import { normalizeAtomicAgentBaseUrl } from "./execute.js";

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
  const rawBase = asString(config.baseUrl, "");
  if (!rawBase.trim()) {
    checks.push({
      code: "atomic_agent_http_base_url_missing",
      level: "error",
      message: "atomic_agent_http requires baseUrl.",
      hint: "Point baseUrl at `atomic-agent serve` (e.g. http://127.0.0.1:8787).",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  const baseUrl = normalizeAtomicAgentBaseUrl(rawBase);
  let origin: URL | null = null;
  try {
    origin = new URL(baseUrl);
  } catch {
    checks.push({
      code: "atomic_agent_http_base_url_invalid",
      level: "error",
      message: `Invalid baseUrl: ${rawBase}`,
    });
  }

  if (origin && origin.protocol !== "http:" && origin.protocol !== "https:") {
    checks.push({
      code: "atomic_agent_http_protocol_invalid",
      level: "error",
      message: `Unsupported URL protocol: ${origin.protocol}`,
    });
  }

  if (origin && (origin.protocol === "http:" || origin.protocol === "https:")) {
    checks.push({
      code: "atomic_agent_http_base_normalized",
      level: "info",
      message: `Normalized base: ${baseUrl}`,
    });

    const apiKey = asString(config.apiKey, "").trim();
    const headers: Record<string, string> = {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const modelsUrl = `${baseUrl}/v1/models`;
      const response = await fetch(modelsUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
      });
      if (!response.ok) {
        checks.push({
          code: "atomic_agent_http_models_probe_failed",
          level: "warn",
          message: `GET /v1/models returned HTTP ${response.status}.`,
          hint: "Start `atomic-agent serve` and verify ATOMIC_AGENT_API_KEY if configured.",
        });
      } else {
        checks.push({
          code: "atomic_agent_http_models_probe_ok",
          level: "info",
          message: "GET /v1/models succeeded.",
        });
      }
    } catch (err) {
      checks.push({
        code: "atomic_agent_http_models_probe_error",
        level: "warn",
        message: err instanceof Error ? err.message : "Models probe failed",
        hint: "Ensure atomic-agent is listening and reachable from the Paperclip server.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
