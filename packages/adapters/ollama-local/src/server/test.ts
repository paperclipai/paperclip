import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_OLLAMA_LOCAL_BASE_URL,
  DEFAULT_OLLAMA_LOCAL_MODEL,
} from "../index.js";
import { ensureOllamaModelPulled, probeOllamaReachable } from "./prepare.js";

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
  const baseUrl = asString(config.ollamaBaseUrl, DEFAULT_OLLAMA_LOCAL_BASE_URL);
  const model = asString(config.model, DEFAULT_OLLAMA_LOCAL_MODEL);

  const reachable = await probeOllamaReachable(baseUrl);
  if (!reachable.ok) {
    checks.push({
      code: "ollama_unreachable",
      level: "error",
      message: `Cannot reach Ollama at ${baseUrl}`,
      detail: reachable.detail ?? null,
      hint: "Start Ollama with `ollama serve` (https://ollama.com/download), or update ollamaBaseUrl in adapter config if it lives elsewhere.",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  checks.push({
    code: "ollama_reachable",
    level: "info",
    message: `Ollama is reachable at ${baseUrl}`,
    detail:
      reachable.models && reachable.models.length > 0
        ? `Models pulled: ${reachable.models.join(", ")}`
        : "No models are pulled yet.",
  });

  // Auto-pull the model if missing. Test Environment is also "Prepare
  // Environment" — clicking it should leave the user in a working state.
  let prepLog = "";
  const onLog = async (_stream: "stdout" | "stderr", chunk: string) => {
    prepLog += chunk;
  };
  try {
    await ensureOllamaModelPulled({ model, baseUrl, onLog });
    checks.push({
      code: "ollama_model_ready",
      level: "info",
      message: `Model "${model}" is available.`,
      detail: prepLog.trim() ? prepLog.trim().slice(-2000) : null,
    });
  } catch (err) {
    checks.push({
      code: "ollama_model_pull_failed",
      level: "warn",
      message: `Could not auto-pull "${model}".`,
      detail: prepLog.trim() ? prepLog.trim().slice(-2000) : (err instanceof Error ? err.message : null),
      hint: `Run \`ollama pull ${model}\` manually and retry.`,
    });
  }

  return {
    adapterType: ctx.adapterType,
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}

/**
 * Lightweight check used by the Adapters page sign-in/auth-status badge,
 * matching the shape aider-local exposes. Ollama has no auth concept, so
 * "logged in" means "reachable + at least one model pulled".
 */
export async function readOllamaAuthStatus(
  ollamaBaseUrl: string = DEFAULT_OLLAMA_LOCAL_BASE_URL,
): Promise<{ loggedIn: boolean; authMethod: string; modelsCount: number; baseUrl: string }> {
  const probe = await probeOllamaReachable(ollamaBaseUrl);
  return {
    loggedIn: probe.ok && (probe.models?.length ?? 0) > 0,
    authMethod: "Local Ollama",
    modelsCount: probe.models?.length ?? 0,
    baseUrl: ollamaBaseUrl,
  };
}
