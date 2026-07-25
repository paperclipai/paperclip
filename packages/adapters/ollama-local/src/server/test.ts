import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { buildTagsEndpoint } from "./client.js";

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
  const baseUrl = asString(config.baseUrl ?? config.url, "http://127.0.0.1:11434");
  const configuredModel = asString(config.model, "").trim();
  const endpoint = buildTagsEndpoint(baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(endpoint, { signal: controller.signal });
    if (!response.ok) {
      checks.push({
        code: "ollama_endpoint_unreachable",
        level: "error",
        message: `Ollama tags endpoint returned HTTP ${response.status}.`,
        detail: endpoint,
        hint: "Start Ollama and verify the configured base URL.",
      });
    } else {
      checks.push({ code: "ollama_endpoint_reachable", level: "info", message: `Ollama endpoint reachable: ${endpoint}` });
      const payload = await response.json() as { models?: Array<{ name?: unknown }> };
      const models = Array.isArray(payload.models)
        ? payload.models.map((model) => typeof model.name === "string" ? model.name : "").filter(Boolean)
        : [];
      if (configuredModel && models.includes(configuredModel)) {
        checks.push({ code: "ollama_model_available", level: "info", message: `Configured model is available: ${configuredModel}` });
      } else if (configuredModel) {
        checks.push({
          code: "ollama_model_unavailable",
          level: "warn",
          message: `Configured model was not returned by Ollama: ${configuredModel}`,
          hint: "Run `ollama list` and choose an installed model.",
        });
      } else {
        checks.push({ code: "ollama_model_missing", level: "error", message: "ollama_local requires a configured model." });
      }
    }
  } catch (error) {
    checks.push({
      code: "ollama_endpoint_unreachable",
      level: "error",
      message: error instanceof Error && error.name === "AbortError" ? "Ollama endpoint probe timed out." : "Ollama endpoint is unreachable.",
      detail: error instanceof Error ? error.message : String(error),
      hint: "Start Ollama and verify the configured base URL.",
    });
  } finally {
    clearTimeout(timer);
  }
  return { adapterType: ctx.adapterType, status: summarizeStatus(checks), checks, testedAt: new Date().toISOString() };
}
