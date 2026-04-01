import type {
  ServerAdapterModule,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { execute } from "./execute.js";
import * as metadata from "../index.js";

async function testEnvironment(
  ctx: AdapterEnvironmentTestContext
): Promise<AdapterEnvironmentTestResult> {
  const config = ctx.config as Record<string, unknown>;
  const ollamaUrl = (config.ollama_url as string) || "http://localhost:11434";

  const checks = [];

  // Check Ollama connectivity
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      checks.push({
        code: "ollama_connect",
        level: "info" as const,
        message: `Connected to Ollama at ${ollamaUrl}`,
      });

      // Check if requested model is available
      const data = (await response.json()) as Record<string, unknown>;
      const models = (data.models as Array<Record<string, unknown>>) || [];
      const modelName = (config.model as string) || "qwen3.5";
      const modelExists = models.some((m) => (m.name as string)?.includes(modelName));

      if (modelExists) {
        checks.push({
          code: "model_available",
          level: "info" as const,
          message: `Model "${modelName}" is available`,
        });
      } else {
        checks.push({
          code: "model_missing",
          level: "warn" as const,
          message: `Model "${modelName}" not found`,
          detail: `Available models: ${models.map((m) => m.name).join(", ")}`,
          hint: `Run: ollama pull ${modelName}`,
        });
      }
    } else {
      checks.push({
        code: "ollama_connect_error",
        level: "error" as const,
        message: `Ollama returned ${response.status}`,
      });
    }
  } catch (error) {
    checks.push({
      code: "ollama_unreachable",
      level: "error" as const,
      message: `Cannot reach Ollama at ${ollamaUrl}`,
      detail: error instanceof Error ? error.message : String(error),
      hint: "Is Ollama running? Run: ollama serve",
    });
  }

  const hasError = checks.some((c) => c.level === "error");
  const status = hasError ? ("fail" as const) : ("pass" as const);

  return {
    adapterType: ctx.adapterType,
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}

export const module: ServerAdapterModule = {
  type: metadata.type,
  execute,
  testEnvironment,
  models: metadata.models,
};

export default module;
