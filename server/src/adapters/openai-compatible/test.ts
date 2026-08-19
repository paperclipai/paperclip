import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  return checks.some((check) => check.level === "error") ? "fail" : "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const checks: AdapterEnvironmentCheck[] = [];
  const url = asString(config.url, "").trim();
  const baseUrl = asString(config.baseUrl, "").trim();
  const model = asString(config.model, "").trim();

  try {
    const target = url || baseUrl;
    if (!target) throw new Error("Set adapterConfig.baseUrl or adapterConfig.url.");
    const parsed = new URL(target);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL must use http or https.");
    }
    checks.push({
      code: "openai_compatible_url_valid",
      level: "info",
      message: `Configured endpoint origin: ${parsed.origin}`,
    });
  } catch (err) {
    checks.push({
      code: "openai_compatible_url_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid OpenAI-compatible endpoint URL.",
    });
  }

  if (!model) {
    checks.push({
      code: "openai_compatible_model_missing",
      level: "error",
      message: "OpenAI-compatible adapter requires adapterConfig.model.",
    });
  } else {
    checks.push({
      code: "openai_compatible_model_present",
      level: "info",
      message: `Configured model: ${model}`,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
