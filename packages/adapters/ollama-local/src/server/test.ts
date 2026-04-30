import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
  AdapterEnvironmentTestStatus,
} from "@paperclipai/adapter-utils";
import { ollamaGetJson, type OllamaHttpError } from "./http.js";
import { resolveOllamaConfig } from "./config.js";

interface OllamaVersionResponse {
  version?: string;
}

interface OllamaTagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    details?: { parameter_size?: string; quantization_level?: string };
  }>;
}

function escalate(current: AdapterEnvironmentTestStatus, next: AdapterEnvironmentTestStatus): AdapterEnvironmentTestStatus {
  if (current === "fail" || next === "fail") return "fail";
  if (current === "warn" || next === "warn") return "warn";
  return "pass";
}

function httpErrorToCheck(err: OllamaHttpError, route: string): AdapterEnvironmentCheck {
  return {
    code: `ollama_${err.code}`,
    level: "error",
    message: `Ollama ${route} failed: ${err.message}`,
    detail: err.hint ?? null,
  };
}

/**
 * Run /api/version and /api/tags against the configured Ollama endpoint.
 * Returns a structured test result that the UI and status-line renderer
 * can consume.
 */
export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const config = resolveOllamaConfig(ctx.config);
  const checks: AdapterEnvironmentCheck[] = [];
  let status: AdapterEnvironmentTestStatus = "pass";
  const shortTimeout = Math.min(config.requestTimeoutSec, 10);

  // /api/version
  try {
    const version = await ollamaGetJson<OllamaVersionResponse>(
      config.baseUrl,
      "/api/version",
      shortTimeout,
    );
    checks.push({
      code: "ollama_reachable",
      level: "info",
      message: `Ollama reachable at ${config.baseUrl}`,
      detail: version?.version ? `server version ${version.version}` : null,
    });
  } catch (err) {
    const httpErr = err as OllamaHttpError;
    checks.push(httpErrorToCheck(httpErr, "/api/version"));
    return {
      adapterType: "ollama_local",
      status: "fail",
      checks,
      testedAt: new Date().toISOString(),
    };
  }

  // /api/tags
  try {
    const tags = await ollamaGetJson<OllamaTagsResponse>(
      config.baseUrl,
      "/api/tags",
      shortTimeout,
    );
    const models = Array.isArray(tags?.models) ? tags!.models : [];
    const installedNames = models
      .map((entry) => entry?.name ?? entry?.model ?? "")
      .filter((name): name is string => typeof name === "string" && name.length > 0);
    const match = installedNames.find((name) => name === config.model);
    if (match) {
      checks.push({
        code: "ollama_model_available",
        level: "info",
        message: `Model "${config.model}" is installed locally.`,
      });
    } else {
      status = escalate(status, "warn");
      checks.push({
        code: "ollama_model_missing",
        level: "warn",
        message: `Model "${config.model}" was not found in \`ollama list\`.`,
        hint: `Run \`ollama pull ${config.model}\` before using this agent.`,
        detail:
          installedNames.length > 0
            ? `Installed models: ${installedNames.slice(0, 6).join(", ")}${installedNames.length > 6 ? ", …" : ""}`
            : "No models are installed on this Ollama server.",
      });
    }
  } catch (err) {
    const httpErr = err as OllamaHttpError;
    checks.push(httpErrorToCheck(httpErr, "/api/tags"));
    status = escalate(status, "fail");
  }

  return {
    adapterType: "ollama_local",
    status,
    checks,
    testedAt: new Date().toISOString(),
  };
}
