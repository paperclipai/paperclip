import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { testEnvironment as claudeTestEnvironment } from "@paperclipai/adapter-claude-local/server";
import { testOpenAICompatAvailability, resolveBaseUrl } from "./openai-compat.js";
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

  // Run Claude CLI checks in parallel with local endpoint checks
  const [claudeResult, localResult] = await Promise.all([
    claudeTestEnvironment(ctx).catch((err) => null),
    testOpenAICompatAvailability(localBaseUrl),
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

  // Local endpoint checks
  if (localResult.available) {
    checks.push({
      code: "local_openai_compat_available",
      level: "info",
      message: `Local inference endpoint is running at ${localBaseUrl}`,
    });

    if (localResult.models.length > 0) {
      checks.push({
        code: "local_openai_compat_models_loaded",
        level: "info",
        message: `Local endpoint has ${localResult.models.length} model(s) loaded: ${localResult.models.join(", ")}`,
      });

      // Check if the configured model is available on the local endpoint
      if (model && !isClaudeModel(model)) {
        const modelLoaded = localResult.models.some(
          (m) => m === model || m.includes(model) || model.includes(m),
        );
        if (modelLoaded) {
          checks.push({
            code: "local_openai_compat_model_found",
            level: "info",
            message: `Configured model "${model}" is available on the local endpoint.`,
          });
        } else {
          checks.push({
            code: "local_openai_compat_model_not_found",
            level: "warn",
            message: `Configured model "${model}" was not found on the local endpoint.`,
            hint: `Load the model in your local inference server (LM Studio, Ollama, etc.), or choose from: ${localResult.models.join(", ")}`,
          });
        }
      }
    } else {
      checks.push({
        code: "local_openai_compat_no_models",
        level: "warn",
        message: "Local inference endpoint is running but no models are loaded.",
        hint: "Load a model in your local inference server (LM Studio, Ollama, etc.) to use local inference.",
      });
    }
  } else {
    checks.push({
      code: "local_openai_compat_unavailable",
      level: model && !isClaudeModel(model) ? "error" : "warn",
      message: localResult.error ?? `Local inference endpoint is not available at ${localBaseUrl}`,
      hint: `Start your local inference server (LM Studio, Ollama, LiteLLM, etc.) at ${localBaseUrl}. LM Studio: https://lmstudio.ai, Ollama: https://ollama.com`,
    });
  }

  // Summary check for the combined adapter
  const hasClaude = claudeResult?.status !== "fail";
  const hasLocal = localResult.available;
  if (!hasClaude && !hasLocal) {
    checks.push({
      code: "local_no_backends",
      level: "error",
      message: "Neither Claude CLI nor a local inference endpoint is available.",
      hint: "Install Claude CLI (`npm install -g @anthropic-ai/claude-code`) and/or start a local inference server (LM Studio, Ollama, etc.).",
    });
  } else if (hasClaude && hasLocal) {
    checks.push({
      code: "local_both_backends_ready",
      level: "info",
      message: "Both Claude CLI and local inference backends are available.",
    });
  }

  return {
    adapterType: "hybrid_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
