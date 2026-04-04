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

  const apiKey = asString(config.apiKey, process.env.OLLAMA_API_KEY ?? "");
  const model = asString(config.model, "kimi-k2.5:cloud");

  if (!apiKey) {
    checks.push({
      code: "ollama_cloud_api_key_missing",
      level: "error",
      message: "Missing Ollama Cloud API key.",
      hint: "Set the OLLAMA_API_KEY environment variable or configure apiKey in agent settings.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "ollama_cloud_api_key_present",
    level: "info",
    message: "Ollama Cloud API key configured.",
  });

  // Probe the Ollama Cloud tags endpoint to verify connectivity and auth
  try {
    const res = await fetch("https://ollama.com/api/tags", {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) {
      checks.push({
        code: "ollama_cloud_connection_ok",
        level: "info",
        message: "Connected to Ollama Cloud.",
      });
    } else {
      checks.push({
        code: "ollama_cloud_connection_failed",
        level: "error",
        message: `Ollama Cloud API returned HTTP ${res.status}.`,
        hint: "Verify the API key is valid and has access to Ollama Cloud.",
      });
    }
  } catch {
    checks.push({
      code: "ollama_cloud_connection_failed",
      level: "warn",
      message: "Could not reach Ollama Cloud API.",
      hint: "Check network connectivity from the Ironworks server host.",
    });
  }

  checks.push({
    code: "ollama_cloud_model_configured",
    level: "info",
    message: `Model: ${model}`,
  });

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
