import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { resolveZaiConfig } from "../shared/config.js";
import { models } from "../index.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

async function pingModels(baseUrl: string, apiKey: string, timeoutMs: number): Promise<AdapterEnvironmentCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        code: "zai_models_probe_failed",
        level: res.status === 401 || res.status === 403 ? "error" : "warn",
        message: `Z.AI /models probe returned HTTP ${res.status}.`,
        hint:
          res.status === 401 || res.status === 403
            ? "Check that apiKey / ZAI_API_KEY is valid."
            : "Endpoint reachable but not returning 200. Check baseUrl.",
      };
    }
    return {
      code: "zai_models_probe_ok",
      level: "info",
      message: "Z.AI /models endpoint reachable and authorized.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const aborted = message.toLowerCase().includes("abort");
    return {
      code: aborted ? "zai_models_probe_timeout" : "zai_models_probe_error",
      level: "error",
      message: aborted ? `Z.AI /models probe timed out after ${timeoutMs}ms.` : `Z.AI /models probe failed: ${message}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const resolved = resolveZaiConfig(ctx.config);

  if (!resolved.apiKey) {
    checks.push({
      code: "zai_api_key_missing",
      level: "error",
      message: "No Z.AI API key configured.",
      hint: "Set adapterConfig.apiKey or the ZAI_API_KEY environment variable.",
    });
  } else {
    checks.push({
      code: "zai_api_key_present",
      level: "info",
      message: "Z.AI API key configured.",
    });
  }

  try {
    const url = new URL(resolved.baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      checks.push({
        code: "zai_base_url_protocol_invalid",
        level: "error",
        message: `Unsupported base URL protocol: ${url.protocol}`,
        hint: "Use http:// or https://.",
      });
    } else {
      checks.push({
        code: "zai_base_url_valid",
        level: "info",
        message: `Configured base URL: ${url.toString()}`,
      });
    }
  } catch {
    checks.push({
      code: "zai_base_url_invalid",
      level: "error",
      message: `Invalid base URL: ${resolved.baseUrl}`,
    });
  }

  const knownModelIds = new Set(models.map((m) => m.id));
  if (!knownModelIds.has(resolved.model)) {
    checks.push({
      code: "zai_model_unknown",
      level: "warn",
      message: `Model "${resolved.model}" is not in the built-in GLM list.`,
      hint: "The API may still accept it; verify the model id with Z.AI docs.",
    });
  }

  if (resolved.apiKey && !checks.some((c) => c.level === "error")) {
    checks.push(await pingModels(resolved.baseUrl, resolved.apiKey, Math.min(resolved.timeoutMs, 10_000)));
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
