import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asNumber, asString } from "@paperclipai/adapter-utils/server-utils";
import { DEFAULT_LOCAL_MODEL } from "../index.js";
import { getLocalInferenceHealth, resolveLocalBaseUrl } from "./health.js";

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const model = asString(ctx.config.model, DEFAULT_LOCAL_MODEL).trim() || DEFAULT_LOCAL_MODEL;
  const baseUrl = asString(ctx.config.baseUrl, "");
  const health = await getLocalInferenceHealth({
    baseUrl,
    timeoutSec: asNumber(ctx.config.timeoutSec, 0),
  });
  const checks: AdapterEnvironmentCheck[] = [
    {
      code: "local_model_configured",
      level: model ? "info" : "error",
      message: model ? `Configured model: ${model}` : "Local adapter requires a model.",
    },
    {
      code: health.available ? "local_inference_available" : "local_inference_unavailable",
      level: health.available ? "info" : "error",
      message: health.available
        ? `Local inference is available at ${health.url}.`
        : `Local inference is unavailable at ${resolveLocalBaseUrl(baseUrl)}.`,
      detail: health.error ?? null,
    },
  ];

  if (health.models.length > 0 && !health.models.includes(model)) {
    checks.push({
      code: "local_model_not_listed",
      level: "warn",
      message: `Configured model "${model}" was not listed by the local endpoint.`,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
