import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { testEnvironment as claudeTestEnvironment } from "@paperclipai/adapter-claude-local/server";
import { testLMStudioAvailability, resolveBaseUrl } from "./lmstudio.js";
import { isClaudeModel } from "../index.js";

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
  const model = asString(config.model, "");
  const localBaseUrl = resolveBaseUrl(config.localBaseUrl);

  // Run Claude CLI checks in parallel with LM Studio checks
  const [claudeResult, lmStudioResult] = await Promise.all([
    claudeTestEnvironment(ctx).catch((err) => null),
    testLMStudioAvailability(localBaseUrl),
  ]);

  // Claude CLI checks
  if (claudeResult) {
    for (const check of claudeResult.checks) {
      checks.push({
        ...check,
        code: `local_${check.code}`,
      });
    }
  } else {
    checks.push({
      code: "local_claude_check_failed",
      level: "warn",
      message: "Could not run Claude CLI environment checks.",
      hint: "Ensure the Claude CLI is installed if you want to use Claude models.",
    });
  }

  // LM Studio checks
  if (lmStudioResult.available) {
    checks.push({
      code: "local_lmstudio_available",
      level: "info",
      message: `LM Studio is running at ${localBaseUrl}`,
    });

    if (lmStudioResult.models.length > 0) {
      checks.push({
        code: "local_lmstudio_models_loaded",
        level: "info",
        message: `LM Studio has ${lmStudioResult.models.length} model(s) loaded: ${lmStudioResult.models.join(", ")}`,
      });

      // Check if the configured model is available in LM Studio
      if (model && !isClaudeModel(model)) {
        const modelLoaded = lmStudioResult.models.some(
          (m) => m === model || m.includes(model) || model.includes(m),
        );
        if (modelLoaded) {
          checks.push({
            code: "local_lmstudio_model_found",
            level: "info",
            message: `Configured model "${model}" is available in LM Studio.`,
          });
        } else {
          checks.push({
            code: "local_lmstudio_model_not_found",
            level: "warn",
            message: `Configured model "${model}" was not found in LM Studio's loaded models.`,
            hint: `Load the model in LM Studio, or choose from: ${lmStudioResult.models.join(", ")}`,
          });
        }
      }
    } else {
      checks.push({
        code: "local_lmstudio_no_models",
        level: "warn",
        message: "LM Studio is running but no models are loaded.",
        hint: "Load a model in LM Studio to use local inference.",
      });
    }
  } else {
    checks.push({
      code: "local_lmstudio_unavailable",
      level: model && !isClaudeModel(model) ? "error" : "warn",
      message: lmStudioResult.error ?? `LM Studio is not available at ${localBaseUrl}`,
      hint: `Start LM Studio and ensure it's serving at ${localBaseUrl}. Download from https://lmstudio.ai`,
    });
  }

  // Summary check for the combined adapter
  const hasClaude = claudeResult?.status !== "fail";
  const hasLocal = lmStudioResult.available;
  if (!hasClaude && !hasLocal) {
    checks.push({
      code: "local_no_backends",
      level: "error",
      message: "Neither Claude CLI nor LM Studio is available.",
      hint: "Install Claude CLI (`npm install -g @anthropic-ai/claude-code`) and/or start LM Studio.",
    });
  } else if (hasClaude && hasLocal) {
    checks.push({
      code: "local_both_backends_ready",
      level: "info",
      message: "Both Claude CLI and LM Studio backends are available.",
    });
  }

  return {
    adapterType: "local_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
