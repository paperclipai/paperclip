import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { asString, parseObject, ensureAbsoluteDirectory } from "@paperclipai/adapter-utils/server-utils";
import { discoverOllamaModels } from "./models.js";
import { DEFAULT_OLLAMA_LOCAL_MODEL } from "../index.js";

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
  const baseUrl = asString(config.baseUrl, "http://localhost:11434").trim();
  const model = asString(config.model, DEFAULT_OLLAMA_LOCAL_MODEL).trim();
  const cwd = asString(config.cwd, process.cwd());

  // Check cwd
  try {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: false });
    checks.push({
      code: "ollama_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "ollama_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  // Check Ollama reachability + discover models
  let discoveredModels: Array<{ id: string; label: string }> = [];
  try {
    discoveredModels = await discoverOllamaModels(baseUrl);
    checks.push({
      code: "ollama_reachable",
      level: "info",
      message: `Ollama is reachable at ${baseUrl} — found ${discoveredModels.length} model(s).`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      code: "ollama_unreachable",
      level: "error",
      message: `Cannot reach Ollama at ${baseUrl}: ${msg}`,
      hint: "Make sure Ollama is running: `ollama serve`",
    });
    return {
      adapterType: ctx.adapterType,
      status: summarizeStatus(checks),
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // Check model availability
  if (discoveredModels.length === 0) {
    checks.push({
      code: "ollama_no_models",
      level: "warn",
      message: "Ollama returned no installed models.",
      hint: `Pull a model first: \`ollama pull ${model}\``,
    });
  } else if (model) {
    const modelFound = discoveredModels.some(
      (m) => m.id === model || m.id.startsWith(`${model}:`) || m.id === `${model}:latest`,
    );
    if (modelFound) {
      checks.push({
        code: "ollama_model_available",
        level: "info",
        message: `Configured model "${model}" is available.`,
      });
    } else {
      const sample = discoveredModels
        .slice(0, 8)
        .map((m) => m.id)
        .join(", ");
      checks.push({
        code: "ollama_model_not_found",
        level: "warn",
        message: `Configured model "${model}" was not found in installed models.`,
        detail: `Available: ${sample}${discoveredModels.length > 8 ? ", ..." : ""}`,
        hint: `Pull it with: \`ollama pull ${model}\``,
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
