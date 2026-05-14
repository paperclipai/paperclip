import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { parseObject } from "@paperclipai/adapter-utils/server-utils";

const KILO_MODELS_ENDPOINT = "https://api.kilo.ai/api/gateway/models";
const PROBE_TIMEOUT_MS = 5000;

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((c) => c.level === "error")) return "fail";
  if (checks.some((c) => c.level === "warn")) return "warn";
  return "pass";
}

function resolveApiKey(config: Record<string, unknown>): string | null {
  const configKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  if (configKey) return configKey;
  const envKey = process.env.KILO_API_KEY?.trim();
  return envKey && envKey.length > 0 ? envKey : null;
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);

  const apiKey = resolveApiKey(config);

  if (!apiKey) {
    checks.push({
      code: "kilocode_gateway_no_api_key",
      level: "error",
      message: "KiloCode Gateway: no API key configured.",
      hint: "Set adapterConfig.apiKey or the KILO_API_KEY environment variable.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "kilocode_gateway_api_key_present",
    level: "info",
    message: "KiloCode API key is configured.",
  });

  const model = typeof config.model === "string" ? config.model.trim() : "";
  if (!model) {
    checks.push({
      code: "kilocode_gateway_no_model",
      level: "warn",
      message: "No model specified in adapter config.",
      hint: 'Set adapterConfig.model (e.g. "anthropic/claude-sonnet-4.5").',
    });
  } else {
    checks.push({
      code: "kilocode_gateway_model_configured",
      level: "info",
      message: `Model configured: ${model}`,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(KILO_MODELS_ENDPOINT, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      checks.push({
        code: "kilocode_gateway_models_endpoint_ok",
        level: "info",
        message: "KiloCode /models endpoint is reachable.",
      });
    } else if (response.status === 401 || response.status === 403) {
      checks.push({
        code: "kilocode_gateway_models_auth_failed",
        level: "warn",
        message: `KiloCode /models endpoint returned HTTP ${response.status}.`,
        hint: "The API key may be required or invalid for model listing.",
      });
    } else {
      checks.push({
        code: "kilocode_gateway_models_endpoint_error",
        level: "warn",
        message: `KiloCode /models endpoint returned HTTP ${response.status}.`,
      });
    }
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      checks.push({
        code: "kilocode_gateway_models_endpoint_timeout",
        level: "warn",
        message: "KiloCode /models endpoint timed out.",
        hint: "Network connectivity to api.kilo.ai may be restricted from the Paperclip server host.",
      });
    } else {
      checks.push({
        code: "kilocode_gateway_models_endpoint_unreachable",
        level: "warn",
        message: `KiloCode /models endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
